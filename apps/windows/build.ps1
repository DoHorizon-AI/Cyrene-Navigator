<#
.SYNOPSIS
    Builds and launches the Cyrene Navigator Windows UI prototype.

.DESCRIPTION
    One command, no Visual Studio, no MSIX certificate. The project is unpackaged, so
    `dotnet build` produces an .exe you can run directly.

    IMPORTANT: a WinUI 3 application needs an interactive desktop session. It cannot be launched
    from a non-interactive context — an SSH session, a service, a scheduled task, or WSL interop
    (which lands in session 0). In those cases `Application.Start` fails immediately with
    STATUS_STOWED_EXCEPTION / E_INVALIDARG and no window ever appears. Run this script from a
    normal PowerShell window on the desktop.

    重要：WinUI 3 应用需要交互式桌面会话。从 SSH、服务、计划任务或 WSL interop（会落到
    session 0）启动都会立即失败。请在桌面上的普通 PowerShell 窗口里运行本脚本。

.PARAMETER SelfContained
    Bundle the Windows App Runtime instead of using the installed one. Larger output, but runs
    on a machine that has no Windows App Runtime.

.PARAMETER NoRun
    Build only.

.PARAMETER Fonts
    Also install the Space Grotesk display face for full brand fidelity. Optional: the app falls
    back to Segoe UI Variable Display, which still looks native.

.EXAMPLE
    .\build.ps1
    .\build.ps1 -SelfContained
    .\build.ps1 -Fonts
#>
[CmdletBinding()]
param(
    [switch]$SelfContained,
    [switch]$NoRun,
    [switch]$Fonts,
    [switch]$TypeCheckOnly
)

$Configuration = 'Debug'

if ($TypeCheckOnly) {
    $NoRun = $true
}

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root 'src\Cyrene.Navigator.Windows\Cyrene.Navigator.Windows.csproj'

function Write-Step($text) {
    Write-Host ''
    Write-Host "==> $text" -ForegroundColor Cyan
}

# --- prerequisites ---------------------------------------------------------------------------
Write-Step 'Checking prerequisites'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'The .NET SDK is not on PATH. Install .NET 8 or newer: https://dotnet.microsoft.com/download'
}

$sdks = @(& dotnet --list-sdks)
Write-Host ('   .NET SDKs: ' + (($sdks | ForEach-Object { ($_ -split ' ')[0] }) -join ', '))

$osVersion = [System.Environment]::OSVersion.Version
if ($osVersion.Build -lt 19041) {
    Write-Warning "Windows build $($osVersion.Build) is below the 19041 minimum for the Windows App SDK."
}

# A WinUI app cannot create a window without an interactive desktop. Catching it here turns a
# silent crash into an explanation.
$session = (Get-Process -Id $PID).SessionId
if ($session -eq 0 -or -not [System.Environment]::UserInteractive) {
    Write-Warning 'This shell has no interactive desktop session (session 0 / UserInteractive = false).'
    Write-Warning 'The app will build, but launching it will fail with STATUS_STOWED_EXCEPTION.'
    Write-Warning 'Run this script from a PowerShell window on the desktop instead.'
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
Write-Host "   Target: $arch ($Configuration)"

if (-not $SelfContained) {
    $runtime = @(Get-AppxPackage -Name 'Microsoft.WindowsAppRuntime.1.*' -ErrorAction SilentlyContinue)
    if ($runtime.Count -eq 0) {
        Write-Warning 'No Windows App Runtime 1.x is installed.'
        Write-Warning 'Either install it from https://aka.ms/windowsappsdk/1.8/latest/windowsappruntimeinstall-x64.exe'
        Write-Warning 'or re-run this script with -SelfContained to bundle it.'
    }
    else {
        $versions = ($runtime | ForEach-Object { $_.Version } | Sort-Object -Unique) -join ', '
        Write-Host "   Windows App Runtime: $versions"
    }
}

# --- optional brand font ---------------------------------------------------------------------
if ($Fonts) {
    Write-Step 'Installing Space Grotesk (optional)'
    try {
        $temp = Join-Path $env:TEMP 'space-grotesk'
        New-Item -ItemType Directory -Force -Path $temp | Out-Null
        $zip = Join-Path $temp 'sg.zip'
        Invoke-WebRequest -Uri 'https://fonts.google.com/download?family=Space%20Grotesk' -OutFile $zip
        Expand-Archive -Path $zip -DestinationPath $temp -Force

        $userFonts = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
        New-Item -ItemType Directory -Force -Path $userFonts | Out-Null

        Get-ChildItem -Path $temp -Recurse -Include '*.ttf' | ForEach-Object {
            Copy-Item $_.FullName -Destination $userFonts -Force
            $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
            New-ItemProperty `
                -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts' `
                -Name "$name (TrueType)" -PropertyType String `
                -Value (Join-Path $userFonts $_.Name) -Force | Out-Null
            Write-Host "   installed $($_.Name)"
        }

        Write-Host '   Space Grotesk installed for the current user.'
    }
    catch {
        Write-Warning "Could not install Space Grotesk ($($_.Exception.Message)). The app will use Segoe UI Variable Display instead."
    }
}

# --- build -----------------------------------------------------------------------------------
$buildArgs = @($project, '-c', $Configuration, '-r', $arch, '--nologo')
if ($SelfContained) {
    $buildArgs += @('-p:WindowsAppSDKSelfContained=true', '-p:SelfContained=true')
}

Write-Step 'Building'
& dotnet build @buildArgs
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

$exe = Get-ChildItem -Path (Join-Path $root 'src\Cyrene.Navigator.Windows\bin') `
    -Filter 'CyreneNavigator.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match [regex]::Escape($Configuration) } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $exe) { throw 'Built successfully but could not locate CyreneNavigator.exe under bin.' }

Write-Step 'Build complete'
Write-Host "   $($exe.FullName)"

if ($NoRun) {
    Write-Host ''
    Write-Host 'Launch it with:' -ForegroundColor Yellow
    Write-Host "   & '$($exe.FullName)'"
    return
}

# --- run -------------------------------------------------------------------------------------
Write-Step 'Launching Cyrene Navigator'
$log = Join-Path $exe.DirectoryName 'cyrene-navigator.log'
Remove-Item $log -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $exe.FullName -PassThru
Start-Sleep -Seconds 5
$proc.Refresh()

if ($proc.HasExited) {
    Write-Host ''
    Write-Host "The app exited immediately (exit code $($proc.ExitCode))." -ForegroundColor Red
    if (Test-Path $log) {
        Write-Host 'Startup log:' -ForegroundColor Yellow
        Get-Content $log
    }
    else {
        Write-Host 'No startup log was written, which means the failure happened before managed code ran.' -ForegroundColor Yellow
        Write-Host 'The usual cause is no interactive desktop session, or a missing Windows App Runtime.' -ForegroundColor Yellow
    }
    return
}

Write-Host '   Running.' -ForegroundColor Green
