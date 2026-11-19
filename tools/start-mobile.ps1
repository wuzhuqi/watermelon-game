# Start a local HTTP server for phone access on the same Wi-Fi.
# Local:  http://localhost:8081/
# Phone:  http://<LAN-IP>:8081/
[CmdletBinding()]
param(
  [int]$Port = 8081
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

$ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and
    $_.PrefixOrigin -ne 'WellKnown'
  } |
  Sort-Object InterfaceMetric |
  Select-Object -First 1 -ExpandProperty IPAddress

Write-Host ''
Write-Host 'DAWUHUA - mobile access' -ForegroundColor Cyan
Write-Host ('LOCAL: http://localhost:{0}/' -f $Port) -ForegroundColor Green
if ($ip) {
  Write-Host ('PHONE: http://{0}:{1}/' -f $ip, $Port) -ForegroundColor Green
  Write-Host 'Make sure the phone and PC are on the same Wi-Fi.'
  Write-Host 'If Windows Firewall asks, allow Python on private networks.'
} else {
  Write-Host 'No LAN IPv4 address was detected.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''

$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
  & $python.Source -m http.server $Port --bind 0.0.0.0 --directory $root
  exit $LASTEXITCODE
}

$py = Get-Command py -ErrorAction SilentlyContinue
if ($py) {
  & $py.Source -3 -m http.server $Port --bind 0.0.0.0 --directory $root
  exit $LASTEXITCODE
}

throw 'Python 3 was not found. Install Python 3 or deploy this folder to any static host.'
