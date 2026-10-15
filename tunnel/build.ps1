# Builds the native WDTT tunnel for Windows.
#
#   .\tunnel\build.ps1

$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'src'
$out = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force -Path $out | Out-Null

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw 'Go not found. Install Go 1.26+ from https://go.dev/dl and retry.'
}

Write-Host 'Resolving modules...'
Push-Location $src
try {
  go mod tidy
  $env:CGO_ENABLED = '0'
  go build -trimpath -ldflags '-s -w' -o (Join-Path $out 'wdtt-tunnel.exe') .
} finally {
  Pop-Location
}

Write-Host "OK: $out\wdtt-tunnel.exe"
