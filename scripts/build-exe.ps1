[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$vswhereCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
)
$vswhere = $vswhereCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm was not found. Install Node.js and pnpm, then run pnpm install."
}

if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    throw "Rust was not found. Install the stable MSVC toolchain from https://rustup.rs/."
}

if (-not $vswhere) {
    throw "Visual Studio Installer was not found. Install Visual Studio Build Tools with Desktop development with C++."
}

$vsInstallPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsInstallPath) {
    throw "MSVC build tools were not found. Install the Desktop development with C++ workload."
}

$vsDevCmd = Join-Path $vsInstallPath "Common7\Tools\VsDevCmd.bat"
if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw "VsDevCmd.bat was not found at $vsDevCmd."
}

Push-Location $projectRoot
try {
    Write-Host "Building TechProposal Studio NSIS installer..." -ForegroundColor Cyan
    $buildCommand = 'call "{0}" -no_logo -arch=x64 && pnpm tauri build --bundles nsis' -f $vsDevCmd
    & $env:ComSpec /D /S /C $buildCommand

    if ($LASTEXITCODE -ne 0) {
        throw "EXE build failed with exit code $LASTEXITCODE."
    }

    $bundleDir = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
    $installers = @(Get-ChildItem -LiteralPath $bundleDir -Filter "*.exe" -File -ErrorAction SilentlyContinue)
    if ($installers.Count -eq 0) {
        throw "The build completed, but no NSIS installer was found in $bundleDir."
    }

    Write-Host "`nEXE created:" -ForegroundColor Green
    $installers | ForEach-Object { Write-Host $_.FullName }
}
finally {
    Pop-Location
}
