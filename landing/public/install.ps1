# Covenant installer for Windows
#   irm https://www.covenant.uno/install.ps1 | iex
# PowerShell downloads skip the browser's Mark-of-the-Web, so no SmartScreen
# download wall while releases are unsigned. UAC prompt is expected.
$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '  Covenant — AI-native terminal' -ForegroundColor Cyan
Write-Host ''

$release = Invoke-RestMethod 'https://api.github.com/repos/karluiz/covenant/releases/latest'
$asset = $release.assets | Where-Object { $_.name -like '*x64*.msi' } | Select-Object -First 1
if (-not $asset) { throw 'No Windows MSI found in the latest release.' }

$msi = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $msi -UseBasicParsing
Unblock-File $msi -ErrorAction SilentlyContinue

Write-Host 'Launching installer — accept the UAC prompt...'
Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"" -Wait

Write-Host ''
Write-Host 'Done. Covenant is in your Start menu.' -ForegroundColor Green
