# Starts a local LiveKit server on Windows (downloads it once). Keep this window open while using the site.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$dir = Join-Path $PSScriptRoot 'livekit-bin'
$exe = Join-Path $dir 'livekit-server.exe'

if (-not (Test-Path $exe)) {
  Write-Host 'Downloading LiveKit server (one time only)...'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/livekit/livekit/releases/latest' -Headers @{ 'User-Agent' = 'classroom-setup' }
  $asset = $rel.assets | Where-Object { $_.name -like '*windows*amd64*.zip' } | Select-Object -First 1
  if (-not $asset) { throw 'Windows build not found. Download it manually from https://github.com/livekit/livekit/releases and put livekit-server.exe in the livekit-bin folder.' }
  $zip = Join-Path $dir 'livekit.zip'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  Remove-Item $zip
  if (-not (Test-Path $exe)) {
    $found = Get-ChildItem -Path $dir -Recurse -Filter 'livekit-server.exe' | Select-Object -First 1
    if ($found) { Copy-Item $found.FullName $exe } else { throw 'livekit-server.exe was not found inside the download.' }
  }
}

# Use the same key/secret as the website (.env)
$key = 'devkey'; $secret = 'secret-secret-secret-secret-123456'
if (Test-Path '.env') {
  foreach ($l in Get-Content '.env') {
    if ($l -match '^\s*LIVEKIT_API_KEY\s*=\s*(.+?)\s*$') { $key = $Matches[1] }
    elseif ($l -match '^\s*LIVEKIT_API_SECRET\s*=\s*(.+?)\s*$') { $secret = $Matches[1] }
  }
}
Write-Host "Starting LiveKit on port 7880 - keep this window open. Test: http://localhost:7880 should show OK"
& $exe --keys "${key}: ${secret}"
