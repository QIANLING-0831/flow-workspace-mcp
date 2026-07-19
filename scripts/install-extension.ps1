$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $repoRoot 'extension'
$chromiumPath = Join-Path $env:LOCALAPPDATA 'Chromium\Application\chrome.exe'

Set-Clipboard -Value $extensionPath
Write-Host "Flow Login Bridge folder copied to clipboard:"
Write-Host $extensionPath
Write-Host "In Chromium: enable Developer mode, click Load unpacked, and paste this folder path. No restart is needed."

if (Test-Path -LiteralPath $chromiumPath) {
    Start-Process -FilePath $chromiumPath -ArgumentList 'chrome://extensions/'
}
