# SSL.com eSigner Authenticode signing, invoked by Tauri's bundle.windows.signCommand
# for every Windows artifact (app exe, NSIS installer, MSI). Runs BEFORE the updater
# .sig is computed, so the Tauri auto-updater signature stays valid.
# No-ops when SSLCOM_* secrets are absent so unsigned local/CI builds keep working.
param([Parameter(Mandatory = $true)][string]$FilePath)

$ErrorActionPreference = 'Stop'

if (-not $env:SSLCOM_USERNAME) {
  Write-Host "SSLCOM_USERNAME not set - skipping Authenticode signing of $FilePath"
  exit 0
}

# ponytail: download-once cache in TEMP; the bundler calls this script several times per build
$toolDir = Join-Path ([System.IO.Path]::GetTempPath()) 'codesigntool'
$bat = $null
if (Test-Path $toolDir) {
  $bat = Get-ChildItem $toolDir -Recurse -Filter 'CodeSignTool.bat' | Select-Object -First 1
}
if (-not $bat) {
  Write-Host 'Downloading CodeSignTool...'
  New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
  $zip = Join-Path $toolDir 'CodeSignTool.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest 'https://www.ssl.com/download/codesigntool-for-windows/' -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $toolDir -Force
  $bat = Get-ChildItem $toolDir -Recurse -Filter 'CodeSignTool.bat' | Select-Object -First 1
  if (-not $bat) { throw 'CodeSignTool.bat not found after download' }
}

Write-Host "eSigner signing $FilePath"
& $bat.FullName sign `
  "-credential_id=$env:SSLCOM_CREDENTIAL_ID" `
  "-username=$env:SSLCOM_USERNAME" `
  "-password=$env:SSLCOM_PASSWORD" `
  "-totp_secret=$env:SSLCOM_TOTP_SECRET" `
  "-input_file_path=$FilePath" `
  -override=true
if ($LASTEXITCODE -ne 0) { throw "CodeSignTool exited $LASTEXITCODE for $FilePath" }

# CodeSignTool.bat has been seen exiting 0 on failure - trust the signature, not the exit code.
$sig = Get-AuthenticodeSignature $FilePath
if ($sig.Status -ne 'Valid') { throw "signature on $FilePath is '$($sig.Status)', expected Valid" }
Write-Host "signed OK: $($sig.SignerCertificate.Subject)"
