param(
    [ValidateRange(1024, 65535)][int]$Port = 7816,
    [switch]$LocalOnly,
    [switch]$NoPdf,
    [switch]$NoInstall
)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
Import-Module (Join-Path $projectDirectory 'falsify-connection.psm1') -Force
if (-not (Test-FalsifyPortAvailable -Port $Port)) {
    $alternatePort = if ($Port -lt 65535) { $Port + 1 } else { $Port - 1 }
    throw "Port $Port is already in use on this computer. Nothing was stopped, replaced or reused, and no setup ran. Start again on a free port, e.g. -Port $alternatePort or falsify://connect?port=$alternatePort, and enter the same port on the website."
}
$venvDirectory = Join-Path $projectDirectory '.venv'
$venvPython = Join-Path $venvDirectory 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    if ($NoInstall) { throw 'No local virtual environment. Run once without -NoInstall.' }
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { throw 'Install Python 3.10+ and reopen PowerShell first.' }
    & $pythonCommand.Source -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }
    Write-Host "Setup: creating project-local virtual environment $venvDirectory"
    & $pythonCommand.Source -m venv $venvDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the project-local virtual environment.' }
}
$requirementsFile = Join-Path $projectDirectory 'app/local/requirements.txt'
$fullRequirements = Get-Content -LiteralPath $requirementsFile -Raw
$wantedRequirements = if ($NoPdf) { 'jsonschema==4.26.0' } else { $fullRequirements }
$installStamp = Join-Path $venvDirectory 'falsify-installed-requirements.txt'
$installedRequirements = if (Test-Path -LiteralPath $installStamp) { Get-Content -LiteralPath $installStamp -Raw } else { $null }
$alreadyInstalled = ($installedRequirements -ceq $wantedRequirements) -or ($NoPdf -and $installedRequirements -ceq $fullRequirements)
if (-not $NoInstall -and -not $alreadyInstalled) {
    Write-Host 'Setup: installing pinned Python dependencies from PyPI into .venv (pip output follows).'
    if ($NoPdf) { & $venvPython -m pip install 'jsonschema==4.26.0' }
    else { & $venvPython -m pip install -r $requirementsFile }
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. No broker has been started.' }
    Set-Content -LiteralPath $installStamp -Value $wantedRequirements -NoNewline -Encoding ascii
    Write-Host 'Setup: dependencies installed. Later launches skip pip until requirements change.'
}
Write-Host 'Model CLIs found on PATH (nothing was run, installed or signed in):'
foreach ($cli in Get-FalsifyCliStatus) {
    if ($cli.Installed) { Write-Host "  $($cli.Name): $($cli.Path)" } else { Write-Host "  $($cli.Name): not found" }
}
Write-Host '  Codex CLI and Claude Code are built-in adapters using your own subscription login. Nothing here asks for an API key.'
Write-Host '  If one is not signed in, do it yourself in another terminal: "codex login", or run "claude" and use /login.'
Write-Host '  CLI, model and effort are chosen per role in RED or BLUE on the website, not here. Other CLIs need a trusted custom stdio harness.'
$brokerArguments = @((Join-Path $projectDirectory 'app/local/server.py'), '--port', [string]$Port)
if (-not $LocalOnly) { $brokerArguments += @('--web-origin', (Get-FalsifyConnectionConstants).WebOrigin) }
Write-Host 'Your own CLI login is used. Paste the pairing token printed below into the website yourself; it is never put in a link.'
Write-Host 'This window must remain open. Ctrl+C stops the companion.'
Write-Host 'Only trust your selected harness code. The companion is not an OS sandbox.'
& $venvPython @brokerArguments
if ($LASTEXITCODE -ne 0) { throw 'Companion stopped with an error. If the port is occupied, choose -Port 7817; do not terminate another program.' }
