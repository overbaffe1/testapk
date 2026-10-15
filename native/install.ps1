# Registers the com.wdtt.tunnel native messaging host on Windows.
#
#   .\native\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found in PATH. Install Node.js 18+ and retry." }

$stateDir = Join-Path $env:LOCALAPPDATA 'wdtt-tunnel'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stateDir 'lib') | Out-Null

Copy-Item -Force (Join-Path $RepoRoot 'native\host.js')     (Join-Path $stateDir 'host.js')
Copy-Item -Force (Join-Path $RepoRoot 'native\lib\tunnel.js') (Join-Path $stateDir 'lib\tunnel.js')
Copy-Item -Force (Join-Path $RepoRoot 'native\lib\socks.js')  (Join-Path $stateDir 'lib\socks.js')

$wrapper = Join-Path $stateDir 'wdtt-host.cmd'
@"
@echo off
"$node" "$stateDir\host.js" %*
"@ | Set-Content -Encoding ASCII $wrapper

$manifest = @"
{
  "name": "com.wdtt.tunnel",
  "description": "qWDTT Chrome extension - WDTT tunnel control (local SOCKS5)",
  "path": "$wrapper",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@

$targets = @(
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\NativeMessagingHosts'),
  (Join-Path $env:LOCALAPPDATA 'Chromium\User Data\NativeMessagingHosts'),
  (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data\NativeMessagingHosts'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data\NativeMessagingHosts')
)

foreach ($dir in $targets) {
  if (Test-Path (Split-Path -Parent $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $manifest | Set-Content -Encoding UTF8 (Join-Path $dir 'com.wdtt.tunnel.json')
    Write-Host "OK: $dir\com.wdtt.tunnel.json"
  }
}

Write-Host ''
Write-Host 'Done. Restart Chrome (or reload the extension).'
$tunnelBin = Join-Path $RepoRoot 'tunnel\bin\wdtt-tunnel.exe'
if (-not (Test-Path $tunnelBin)) {
  Write-Host "WARNING: tunnel binary not found - build it with tunnel\build.ps1 (see tunnel\README.md)"
}
