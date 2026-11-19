<#
.SYNOPSIS
  Read-only image verifier: snapshot or verify SHA256 hashes of game assets in img/.

.DESCRIPTION
  This script only reads image files. It never compresses, crops, resamples,
  transcodes, or writes back any image. The game itself also only reads images
  via new Image() / drawImage, so Save -> play -> Verify should report PASS.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/image-hash.ps1 -Save

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/image-hash.ps1 -Verify
#>
[CmdletBinding()]
param(
  [switch]$Save,
  [switch]$Verify,
  [string]$ImageDir,
  [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'

if ($Save -and $Verify) {
  throw 'Choose only one of -Save or -Verify.'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ImageDir)) {
  $ImageDir = Join-Path $scriptDir '..\img'
}
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  $ManifestPath = Join-Path $scriptDir '..\.asset-hashes.json'
}

$expectedNames = @('bj.jpg') + @('00.jpg') + @(1..12 | ForEach-Object { '{0:D2}.jpg' -f $_ }) + @('004.jpg')
$ImageDir = [System.IO.Path]::GetFullPath($ImageDir)
$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)

function Get-ImageDimensions {
  param([string]$Path)
  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop | Out-Null
    $image = [System.Drawing.Image]::FromFile($Path)
    try {
      return [pscustomobject]@{ Width = $image.Width; Height = $image.Height }
    } finally {
      $image.Dispose()
    }
  } catch {
    return [pscustomobject]@{ Width = $null; Height = $null }
  }
}

function Get-Manifest {
  $records = @()
  $missing = @()

  foreach ($name in $expectedNames) {
    $path = Join-Path $ImageDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      $missing += $name
      continue
    }

    $file = Get-Item -LiteralPath $path
    $hash = Get-FileHash -LiteralPath $path -Algorithm SHA256
    $dimensions = Get-ImageDimensions -Path $path

    $records += [ordered]@{
      name          = $name
      bytes         = $file.Length
      sha256        = $hash.Hash.ToUpperInvariant()
      naturalWidth  = $dimensions.Width
      naturalHeight = $dimensions.Height
    }
  }

  return [ordered]@{
    createdAt = (Get-Date).ToString('o')
    imageDir  = $ImageDir
    files     = $records
    missing   = $missing
  }
}

if (-not (Test-Path -LiteralPath $ImageDir -PathType Container)) {
  throw "Image directory not found: $ImageDir"
}

if ($Save) {
  $manifest = Get-Manifest
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
  Write-Host ("Baseline saved: {0}" -f $ManifestPath) -ForegroundColor Green
  Write-Host ("Files: {0}; missing: {1}" -f $manifest.files.Count, $manifest.missing.Count)
  if ($manifest.missing.Count -gt 0) {
    Write-Host ("Missing: {0}" -f ($manifest.missing -join ', ')) -ForegroundColor Yellow
    exit 1
  }
  exit 0
}

if ($Verify) {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Baseline not found: $ManifestPath. Run -Save first."
  }

  $baseline = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $baselineMap = @{}
  foreach ($entry in $baseline.files) {
    $baselineMap[$entry.name] = $entry
  }

  $current = Get-Manifest
  $errors = @()
  $warnings = @()

  foreach ($name in $expectedNames) {
    $before = $baselineMap[$name]
    $after = $current.files | Where-Object { $_.name -eq $name } | Select-Object -First 1

    if ($null -eq $before) {
      $warnings += "No baseline entry for $name"
      continue
    }
    if ($null -eq $after) {
      $errors += "$name is missing"
      continue
    }
    if ($before.sha256 -ne $after.sha256) {
      $errors += "$name SHA256 changed: $($before.sha256) -> $($after.sha256)"
    }
    if ([int64]$before.bytes -ne [int64]$after.bytes) {
      $errors += "$name byte size changed: $($before.bytes) -> $($after.bytes)"
    }
  }

  if ($current.missing.Count -gt 0) {
    $errors += "Missing files: $($current.missing -join ', ')"
  }

  Write-Host ''
  Write-Host 'Image read-only verification (SHA256 + byte size)' -ForegroundColor Cyan
  Write-Host ('Directory: {0}' -f $ImageDir)
  Write-Host ('Baseline:  {0}' -f $baseline.createdAt)
  Write-Host ''

  $current.files | ForEach-Object {
    $status = 'OK'
    $color = 'Green'
    if ($errors -match [regex]::Escape($_.name)) {
      $status = 'CHANGED'
      $color = 'Red'
    }
    $size = if ($_.naturalWidth) { "$($_.naturalWidth)x$($_.naturalHeight)" } else { '?' }
    Write-Host ("{0,-8} {1,12}  {2,-14} {3}" -f $_.name, $_.bytes, $size, $status) -ForegroundColor $color
  }

  if ($warnings.Count -gt 0) {
    Write-Host ''
    $warnings | ForEach-Object { Write-Host "WARN  $_" -ForegroundColor Yellow }
  }

  if ($errors.Count -gt 0) {
    Write-Host ''
    $errors | ForEach-Object { Write-Host "FAIL  $_" -ForegroundColor Red }
    Write-Host ''
    Write-Host 'Result: FAIL (image bytes or hashes changed)' -ForegroundColor Red
    exit 1
  }

  Write-Host ''
  Write-Host 'Result: PASS (all image SHA256 hashes and byte sizes are unchanged)' -ForegroundColor Green
  exit 0
}

# No switch: print current hashes and dimensions without writing anything.
$manifest = Get-Manifest
Write-Host ('Image directory: {0}' -f $ImageDir) -ForegroundColor Cyan
$manifest.files | ForEach-Object {
  $size = if ($_.naturalWidth) { "$($_.naturalWidth)x$($_.naturalHeight)" } else { '?' }
  Write-Host ("{0,-8} {1,10}  {2,-14} {3}" -f $_.name, $_.bytes, $size, $_.sha256)
}
if ($manifest.missing.Count -gt 0) {
  Write-Host ("Missing: {0}" -f ($manifest.missing -join ', ')) -ForegroundColor Yellow
  exit 1
}
Write-Host ''
Write-Host 'Tip: use -Save for a baseline, then -Verify after playing.' -ForegroundColor DarkGray
