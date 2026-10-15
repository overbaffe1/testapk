# Установка qWDTT-компонента для Chrome в Windows (без Node.js и Go).
# Резервный ручной способ; обычно достаточно GUI-файла qwdtt-setup.exe.
# powershell -ExecutionPolicy Bypass -File .\native\install.ps1

param(
  [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId = 'innpafjoibpjdgdemphggiomjlppglgj',
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'wdtt-tunnel'
$binDir = Join-Path $stateDir 'bin'
New-Item -ItemType Directory -Force -Path $stateDir, $binDir | Out-Null

function Find-FirstFile([string[]]$Candidates) {
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path $candidate)) { return (Resolve-Path $candidate).Path }
  }
  return $null
}

$hostSource = Find-FirstFile @(
  (Join-Path $RepoRoot 'bin\wdtt-native-host.exe'),
  (Join-Path $RepoRoot 'tunnel\bin\wdtt-native-host.exe'),
  (Join-Path $RepoRoot 'tunnel\bin\wdtt-native-host-windows-amd64.exe'),
  (Join-Path $RepoRoot 'wdtt-native-host.exe')
)
$tunnelSource = Find-FirstFile @(
  (Join-Path $RepoRoot 'bin\wdtt-tunnel.exe'),
  (Join-Path $RepoRoot 'tunnel\bin\wdtt-tunnel.exe'),
  (Join-Path $RepoRoot 'tunnel\bin\wdtt-tunnel-windows-amd64.exe'),
  (Join-Path $RepoRoot 'wdtt-tunnel.exe')
)

if (-not $hostSource) {
  throw 'wdtt-native-host.exe не найден. Скачайте полный пакет qwdtt-windows-x64.zip, а не только chrome-*.zip.'
}
if (-not $tunnelSource) {
  throw 'wdtt-tunnel.exe не найден. Скачайте полный пакет qwdtt-windows-x64.zip, а не только chrome-*.zip.'
}

$hostExe = Join-Path $stateDir 'wdtt-native-host.exe'
$tunnelExe = Join-Path $binDir 'wdtt-tunnel.exe'
Copy-Item -Force $hostSource $hostExe
Copy-Item -Force $tunnelSource $tunnelExe

$manifestPath = Join-Path $stateDir 'com.wdtt.tunnel.json'
$manifestObject = [ordered]@{
  name = 'com.wdtt.tunnel'
  description = 'qWDTT Chrome extension - WDTT tunnel control'
  path = $hostExe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifestObject | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object Text.UTF8Encoding($false)))

$registryKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.wdtt.tunnel',
  'HKCU:\Software\Chromium\NativeMessagingHosts\com.wdtt.tunnel',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.wdtt.tunnel',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.wdtt.tunnel'
)
foreach ($key in $registryKeys) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
}

Write-Host ''
Write-Host 'qWDTT установлен.' -ForegroundColor Green
Write-Host "Native host: $hostExe"
Write-Host "Tunnel:     $tunnelExe"
Write-Host 'Полностью закройте и снова откройте Chrome. Затем вставьте ссылку и нажмите «Подключить».'
