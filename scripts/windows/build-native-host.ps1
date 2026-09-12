# ┌─────────────────────────────────────────────────────────────────────┐
# │  📄 build-native-host.ps1                                             │
# │  Module: scripts.windows.build-native-host                            │
# │  Role: Builds Navigator's native host with a static MSVC CRT.         │
# │                                                                      │
# │  模块职责：使用静态 MSVC CRT 构建 Navigator 原生宿主                   │
# └─────────────────────────────────────────────────────────────────────┘

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $OutputRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$navigatorRustToolchain = '1.97.1-x86_64-pc-windows-msvc'
$target = 'x86_64-pc-windows-msvc'
$targetRustflags = '-C target-feature=+crt-static'
$targetRustflagsConfig = 'target.x86_64-pc-windows-msvc.rustflags=["-C","target-feature=+crt-static"]'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path

function Resolve-File([string] $Path, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }
    return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
}

function Resolve-Rustup {
    $command = Get-Command -Name 'rustup.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) {
        $command = Get-Command -Name 'rustup' -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if ($null -eq $command) {
        throw 'The pinned Rust toolchain requires rustup.exe on PATH.'
    }
    $path = [string]$command.Source
    if ([string]::IsNullOrWhiteSpace($path)) {
        $path = [string]$command.Path
    }
    if ([string]::IsNullOrWhiteSpace($path)) {
        throw 'The rustup command path could not be resolved.'
    }
    return $path
}

function Assert-PinnedRust([string] $Rustup, [string] $Toolchain, [string] $ExpectedVersion) {
    $versionOutput = & $Rustup run $Toolchain rustc --version --verbose 2>&1
    $rustcExitCode = $LASTEXITCODE
    $versionText = [string]::Join([Environment]::NewLine, @($versionOutput))
    if ($rustcExitCode -ne 0) {
        throw "Rust toolchain $Toolchain is unavailable (rustup exited with $rustcExitCode)."
    }
    if ($versionText -notmatch "(?m)^rustc $([regex]::Escape($ExpectedVersion))(?:\s|$)" -or
        $versionText -notmatch '(?m)^host:\s*x86_64-pc-windows-msvc\s*$') {
        throw "The active Rust toolchain is not $Toolchain."
    }
    return (($versionOutput | Select-Object -First 1).ToString()).Trim()
}

function Invoke-StaticCargoBuild(
    [string] $Rustup,
    [string] $ManifestPath,
    [string] $WorkingDirectory,
    [string] $TargetDirectory,
    [string] $Toolchain,
    [string] $Package,
    [string] $Binary
) {
    $locationPushed = $false
    $exitCode = 0
    try {
        Push-Location -LiteralPath $WorkingDirectory
        $locationPushed = $true
        $cargoArguments = @(
            'run', $Toolchain, 'cargo',
            '--config', $targetRustflagsConfig,
            'rustc',
            '--locked',
            '--manifest-path', $ManifestPath,
            '--target-dir', $TargetDirectory,
            '--package', $Package,
            '--bin', $Binary,
            '--release',
            '--target', $target
        )
        & $Rustup @cargoArguments
        $exitCode = $LASTEXITCODE
    } finally {
        if ($locationPushed) {
            Pop-Location
        }
    }
    if ($exitCode -ne 0) {
        throw "Static $Package build failed (rustup exited with $exitCode)."
    }
}

function Get-BuiltBinary([string] $TargetDirectory, [string] $Binary) {
    return (Join-Path $TargetDirectory "$target/release/$Binary.exe")
}

if (-not [Environment]::Is64BitProcess) {
    throw 'The static native host requires a 64-bit Windows PowerShell process.'
}

$navigatorManifest = Resolve-File (Join-Path $repository 'native/Cargo.toml') 'Navigator native Cargo manifest'
$output = [IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$nativeTarget = Join-Path $output 'native-target'
New-Item -ItemType Directory -Force -Path $nativeTarget | Out-Null

$rustup = Resolve-Rustup
$navigatorRustcVersion = Assert-PinnedRust $rustup $navigatorRustToolchain '1.97.1'

# Apply the static CRT through a command-scoped Cargo config. This covers the
# target crate graph without mutating the caller's Rust environment.
# 通过命令作用域的 Cargo 配置启用静态 CRT，覆盖目标 crate 图，同时不修改调用方的
# Rust 环境。
Invoke-StaticCargoBuild $rustup $navigatorManifest $repository $nativeTarget $navigatorRustToolchain 'cyrene-native-host' 'cyrene-native-host'

$nativeBuilt = Resolve-File (Get-BuiltBinary $nativeTarget 'cyrene-native-host') 'Static cyrene-native-host binary'
$nativeOutput = Join-Path $output 'cyrene-native-host.exe'
Copy-Item -LiteralPath $nativeBuilt -Destination $nativeOutput -Force
$nativeOutput = Resolve-File $nativeOutput 'Copied cyrene-native-host binary'

$record = [ordered]@{
    schemaVersion = 1
    rustToolchains = [ordered]@{
        navigator = $navigatorRustToolchain
    }
    rustc = [ordered]@{
        navigator = $navigatorRustcVersion
    }
    target = $target
    crtLinkage = 'static'
    targetRustflags = $targetRustflags
    navigatorPackageManifest = 'native/Cargo.toml'
    binaries = [ordered]@{
        cyreneNativeHost = [ordered]@{
            file = 'cyrene-native-host.exe'
            sha256 = "sha256:$((Get-FileHash -Algorithm SHA256 -LiteralPath $nativeOutput).Hash.ToLowerInvariant())"
        }
    }
}
$recordPath = Join-Path $output 'native-host.json'
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordPath -Encoding utf8

Write-Output "Static native host ready: $output"
Write-Output "Native host record: $recordPath"
