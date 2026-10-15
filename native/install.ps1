# Устанавливает native-messaging host com.wdtt.tunnel в Windows.
# Запускать из корня распакованного репозитория:
#
#   powershell -ExecutionPolicy Bypass -File .\native\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Stop'

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "Node.js 18+ не найден. Установите LTS с https://nodejs.org/ и повторите команду."
}
$node = $nodeCommand.Source

$stateDir = Join-Path $env:LOCALAPPDATA 'wdtt-tunnel'
$libDir = Join-Path $stateDir 'lib'
$binDir = Join-Path $stateDir 'bin'
New-Item -ItemType Directory -Force -Path $stateDir, $libDir, $binDir | Out-Null

Copy-Item -Force (Join-Path $RepoRoot 'native\host.js') (Join-Path $stateDir 'host.js')
Copy-Item -Force (Join-Path $RepoRoot 'native\lib\tunnel.js') (Join-Path $libDir 'tunnel.js')
Copy-Item -Force (Join-Path $RepoRoot 'native\lib\socks.js') (Join-Path $libDir 'socks.js')

# Windows Chrome запускает native host только как .exe. Маленький C# launcher
# проксирует бинарные stdin/stdout в Node.js-хост и задаёт его рабочий каталог.
$launcherSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

public static class WdttNativeLauncher
{
    public static int Main(string[] args)
    {
        string home = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string node = Environment.GetEnvironmentVariable("WDTT_NODE");
        if (String.IsNullOrWhiteSpace(node)) node = "node.exe";

        var start = new ProcessStartInfo();
        start.FileName = node;
        start.Arguments = "\"" + Path.Combine(home, "host.js") + "\"";
        start.WorkingDirectory = home;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = false;
        start.EnvironmentVariables["WDTT_HOME"] = home;

        try
        {
            using (var child = Process.Start(start))
            {
                var inputThread = new Thread(() =>
                {
                    try
                    {
                        Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream);
                        child.StandardInput.Close();
                    }
                    catch { }
                });
                inputThread.IsBackground = true;
                inputThread.Start();

                child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput());
                Console.OpenStandardOutput().Flush();
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("qWDTT native host: " + error.Message);
            return 1;
        }
    }
}
'@

$launcher = Join-Path $stateDir 'wdtt-native-host.exe'
if (Test-Path $launcher) { Remove-Item -Force $launcher }
Add-Type -TypeDefinition $launcherSource -Language CSharp -OutputAssembly $launcher -OutputType ConsoleApplication

# Копируем готовый туннель из пакета/репозитория, если он присутствует.
$tunnelCandidates = @(
  (Join-Path $RepoRoot 'tunnel\bin\wdtt-tunnel.exe'),
  (Join-Path $RepoRoot 'wdtt-tunnel.exe')
)
$tunnelInstalled = $false
foreach ($candidate in $tunnelCandidates) {
  if (Test-Path $candidate) {
    Copy-Item -Force $candidate (Join-Path $binDir 'wdtt-tunnel.exe')
    $tunnelInstalled = $true
    break
  }
}

$manifestPath = Join-Path $stateDir 'com.wdtt.tunnel.json'
$manifestObject = [ordered]@{
  name = 'com.wdtt.tunnel'
  description = 'qWDTT Chrome extension - WDTT tunnel control (local SOCKS5)'
  path = $launcher
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifestObject | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object Text.UTF8Encoding($false)))

# На Windows Chrome/Edge/Brave ищут путь к manifest в реестре HKCU.
$registryKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.wdtt.tunnel',
  'HKCU:\Software\Chromium\NativeMessagingHosts\com.wdtt.tunnel',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.wdtt.tunnel',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.wdtt.tunnel'
)
foreach ($key in $registryKeys) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
  Write-Host "OK: $key"
}

Write-Host ''
Write-Host "Native host установлен: $launcher" -ForegroundColor Green
if ($tunnelInstalled) {
  Write-Host "Туннель установлен: $binDir\wdtt-tunnel.exe" -ForegroundColor Green
} else {
  Write-Host "ВНИМАНИЕ: wdtt-tunnel.exe не найден." -ForegroundColor Yellow
  Write-Host "Положите его в $binDir\wdtt-tunnel.exe или выполните .\tunnel\build.ps1"
}
Write-Host 'Полностью закройте и снова запустите Chrome, затем нажмите «Подключить».'
