$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'pdf-editor-config.psm1') -Force
$checks = 0
function Check([string]$Name, [bool]$Pass) { $script:checks++; if (-not $Pass) { throw "FAIL: $Name" }; Write-Host "ok $Name" }
function Rejects([scriptblock]$Block) { try { $null = & $Block; return $false } catch { return $true } }
$root = Split-Path -Parent $PSScriptRoot
$emptyProject = Join-Path ([IO.Path]::GetTempPath()) ('falsify-pdf-config-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $emptyProject
try { Check 'unconfigured preserves legacy' ($null -eq (Resolve-FalsifyPdfEditorConfig -ProjectDirectory $emptyProject)) }
finally { Remove-Item -LiteralPath $emptyProject }
Check 'NoPdf disables even malformed explicit configuration' ($null -eq (Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot 'invalid' -Disabled))
Check 'partial root rejects' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot 'C:\missing' })
Check 'partial manifest rejects' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorManifest 'C:\missing' })
Check 'relative paths reject' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot '.\editor' -EditorManifest '.\candidate-manifest.json' })
Check 'URLs reject' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot 'https://evil.invalid/editor' -EditorManifest 'https://evil.invalid/manifest' })
Check 'UNC paths reject' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot '\\server\editor' -EditorManifest '\\server\manifest' })
Check 'missing local paths reject' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot 'C:\falsify-no-such-editor' -EditorManifest 'C:\falsify-no-such-manifest.json' })
$tokens = $null; $errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'pdf-editor-config.psm1'), [ref]$tokens, [ref]$errors)
Check 'module syntax' (@($errors).Count -eq 0)
Write-Host "$checks checks passed; no installation, process, registry or network mutations."
exit 0
