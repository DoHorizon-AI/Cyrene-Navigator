<#
.SYNOPSIS
    Packages Cyrene Installer as an MSIX Windows installer package.
    将 Cyrene Installer 打包为 MSIX Windows 现代化安装包与独立执行程序。
#>

param(
    [string]$LayoutDir = "dist/msix-layout",
    [string]$OutputMsix = "dist/installer.msix",
    [string]$CertSubject = "CN=DoHorizon-AI"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Cyrene Installer Packaging Automation                   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Resolve Windows SDK tools
Write-Host ">> Searching for Windows SDK tools (MakeAppx.exe & SignTool.exe)..."
$makeAppx = (Get-Command "MakeAppx.exe" -ErrorAction SilentlyContinue)?.Source
$signTool = (Get-Command "SignTool.exe" -ErrorAction SilentlyContinue)?.Source

if (-not $makeAppx -or -not $signTool -or $makeAppx -like "*\arm64\*") {
    $x64Tools = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10\bin" -Filter "MakeAppx.exe" -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like "*\x64\*" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1

    if ($x64Tools) {
        $sdkDir = $x64Tools.DirectoryName
        $env:PATH = "$sdkDir;$env:PATH"
        $makeAppx = Join-Path $sdkDir "MakeAppx.exe"
        $signTool = Join-Path $sdkDir "SignTool.exe"
        Write-Host "Found x64 SDK tools in: $sdkDir" -ForegroundColor Green
    } else {
        throw "Could not find x64 MakeAppx.exe or SignTool.exe. Please install the Windows SDK."
    }
}

# 2. Prepare layout directory
Write-Host ">> Preparing MSIX layout in: $LayoutDir"
if (Test-Path $LayoutDir) {
    Remove-Item -Recurse -Force $LayoutDir
}
New-Item -ItemType Directory -Force -Path $LayoutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $LayoutDir "Assets") | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputMsix) | Out-Null

# Copy Manifest and Assets
Copy-Item "installer/AppxManifest.xml" -Destination (Join-Path $LayoutDir "AppxManifest.xml")
Copy-Item "installer/Assets/*" -Destination (Join-Path $LayoutDir "Assets") -Recurse

# Copy compiled binaries
$installerBin = "native/target/release/installer.exe"
$nativeHostBin = "native/target/release/cyrene-native-host.exe"

if (Test-Path $installerBin) {
    Copy-Item $installerBin -Destination (Join-Path $LayoutDir "installer.exe")
    # Also copy standalone installer to dist/ for direct portable use
    Copy-Item $installerBin -Destination (Join-Path (Split-Path -Parent $OutputMsix) "installer.exe")
} else {
    Write-Warning "Installer binary not found at $installerBin; please build with cargo first."
}

if (Test-Path $nativeHostBin) {
    Copy-Item $nativeHostBin -Destination (Join-Path $LayoutDir "cyrene-native-host.exe")
    Copy-Item $nativeHostBin -Destination (Join-Path (Split-Path -Parent $OutputMsix) "cyrene-native-host.exe")
}

# 3. Create or export code signing certificate
$pfxPath = Join-Path (Split-Path -Parent $OutputMsix) "cyrene-dev-cert.pfx"
$pfxPass = "CyreneDev2026!"
$securePass = ConvertTo-SecureString -String $pfxPass -Force -AsPlainText

Write-Host ">> Generating self-signed code signing certificate ($CertSubject)..."
$cert = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $CertSubject `
    -KeyUsage DigitalSignature `
    -FriendlyName "Cyrene Dev Cert" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePass | Out-Null

# 4. Pack into MSIX
Write-Host ">> Running MakeAppx to build MSIX package: $OutputMsix..."
& $makeAppx pack /d $LayoutDir /p $OutputMsix /o
if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx failed with exit code $LASTEXITCODE"
}

# 5. Sign the MSIX package
Write-Host ">> Signing MSIX package with SignTool..."
& $signTool sign /fd SHA256 /a /f $pfxPath /p $pfxPass $OutputMsix
if ($LASTEXITCODE -ne 0) {
    throw "SignTool failed with exit code $LASTEXITCODE"
}

Write-Host "`n✅ Successfully generated and signed MSIX package:" -ForegroundColor Green
Write-Host "   $OutputMsix" -ForegroundColor Green
Write-Host "   Cert: $pfxPath (Password: $pfxPass)" -ForegroundColor Gray
Write-Host "   Standalone binary: $(Join-Path (Split-Path -Parent $OutputMsix) 'installer.exe')" -ForegroundColor Green
