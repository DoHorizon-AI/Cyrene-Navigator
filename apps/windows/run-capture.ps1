param(
    [string]$Configuration = "Release"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root "src\Cyrene.Navigator.Windows\bin\$Configuration\net8.0-windows10.0.26100.0\win-x64\CyreneNavigator.exe"
$shots = Join-Path $root "design-shots"
Write-Host "Exe: $exe"
Write-Host "Shots: $shots"

$log = Join-Path (Split-Path $exe) "cyrene-navigator.log"
if (Test-Path $log) { Remove-Item $log -Force }

$proc = Start-Process -FilePath $exe -ArgumentList @("--capture", $shots) -PassThru -Wait
Write-Host "ExitCode: $($proc.ExitCode)"

if (Test-Path $log) {
    Write-Host "=== Log ==="
    Get-Content $log
}
