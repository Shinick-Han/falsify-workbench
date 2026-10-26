<#
Target of the per-user falsify:// protocol. Windows passes the clicked link as the single
argument. Port-only links and one-time pairing links are accepted, including the single empty
root slash Windows ShellExecute inserts. Anything else stops here, before any network, Python,
model or child process. A pairing link carries a port plus challenge, state and proof. It never
carries a bearer token, password, command, model or website origin. The companion always pairs
with the fixed hosted website origin, and only after a visible approval.
#>
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'falsify-connection.psm1') -Force

function Show-FalsifyVisibleApproval {
    $origin = (Get-FalsifyConnectionConstants).WebOrigin
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $text = "Allow $origin to receive a short-lived local reconnect credential?`r`n`r`nThis does not run a model and does not reveal the server process token.`r`n`r`nNo cancels."
        # Button2 is No, so Enter does not approve.
        $result = [System.Windows.Forms.MessageBox]::Show($text, 'Falsify local companion', 'YesNo', 'Warning', 'Button2')
        return ($result -eq [System.Windows.Forms.DialogResult]::Yes)
    } catch {
        throw 'Visible approval is unavailable. Use the manual token fallback. Nothing was approved.'
    }
}

if ($args.Count -ne 1) { throw 'Rejected: expected exactly one falsify://connect?port=<1024-65535> (or falsify://connect/?port=<1024-65535>) link.' }
$link = ConvertFrom-FalsifyConnectLink -Uri ([string]$args[0])
[int]$port = $link.Port
$launcher = Join-Path $PSScriptRoot 'start-companion.ps1'
if (-not $link.Pairing) {
    $Host.UI.RawUI.WindowTitle = "Falsify local companion (port $port)"
    Write-Host "Falsify connect link accepted for 127.0.0.1 port $port."
    if ($env:FALSIFY_CONNECT_DRY_RUN -eq '1') {
        Write-Output "DRY-RUN start-companion port=$port launcher=$launcher"
        return
    }
    & $launcher -Port $port
    return
}

$decision = Get-FalsifyApprovalDecision -Origin (Get-FalsifyConnectionConstants).WebOrigin -Choice $env:FALSIFY_CONNECT_APPROVAL
if ($decision -eq 'Ask') { $decision = if (Show-FalsifyVisibleApproval) { 'Approve' } else { 'Cancel' } }
if ($decision -ne 'Approve') {
    if ($env:FALSIFY_CONNECT_DRY_RUN -eq '1') { Write-Output "DRY-RUN pairing cancelled port=$port"; exit 2 }
    throw 'Cancelled: the fixed website was not approved. No companion was started and no credential was issued.'
}
if ($env:FALSIFY_CONNECT_DRY_RUN -eq '1') {
    Write-Output "DRY-RUN start-companion port=$port pairing=1 launcher=$launcher"
    return
}
$Host.UI.RawUI.WindowTitle = "Falsify local companion (port $port)"
Write-Host "Falsify pairing link accepted for 127.0.0.1 port $port. Nonces are not shown."
& $launcher -Port $port -Background -PairChallenge $link.Challenge -PairState $link.State -PairProof $link.Proof
