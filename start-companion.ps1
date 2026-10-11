param(
    [ValidateRange(1024, 65535)][int]$Port = 7816,
    [switch]$LocalOnly,
    [switch]$NoPdf,
    [switch]$NoInstall
)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$venvDirectory = Join-Path $projectDirectory '.venv'
$venvPython = Join-Path $venvDirectory 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    if ($NoInstall) { throw 'No local virtual environment. Run once without -NoInstall.' }
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { throw 'Install Python 3.10+ and reopen PowerShell first.' }
    & $pythonCommand.Source -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }
    & $pythonCommand.Source -m venv $venvDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the project-local virtual environment.' }
}
if (-not $NoInstall) {
    if ($NoPdf) { & $venvPython -m pip install 'jsonschema==4.26.0' }
    else { & $venvPython -m pip install -r (Join-Path $projectDirectory 'app/local/requirements.txt') }
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. No broker has been started.' }
}
$brokerArguments = @((Join-Path $projectDirectory 'app/local/server.py'), '--port', [string]$Port)
if (-not $LocalOnly) { $brokerArguments += @('--web-origin', 'https://shinick-han.github.io') }
Write-Host 'Your own CLI login is used. This window must remain open. Ctrl+C stops the companion.'
Write-Host 'Only trust your selected harness code. The companion is not an OS sandbox.'
& $venvPython @brokerArguments
if ($LASTEXITCODE -ne 0) { throw 'Companion stopped with an error. If the port is occupied, choose -Port 7817; do not terminate another program.' }
