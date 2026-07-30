[CmdletBinding()]
param(
    [ValidateRange(1, 10)]
    [int]$MaxAttempts = 3,

    [ValidateRange(1, 300)]
    [int]$RetryDelaySeconds = 10
)

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
    $buildExitCode = 1

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        if ($attempt -gt 1) {
            Write-Host "Retrying EXE build (attempt $attempt of $MaxAttempts)..." -ForegroundColor Yellow
        }

        & $env:ComSpec /D /S /C $buildCommand
        $buildExitCode = $LASTEXITCODE
        if ($buildExitCode -eq 0) {
            break
        }

        if ($attempt -lt $MaxAttempts) {
            $delay = $RetryDelaySeconds * $attempt
            Write-Warning "EXE build attempt $attempt failed with exit code $buildExitCode. Retrying in $delay seconds; completed downloads and build artifacts will be reused."
            Start-Sleep -Seconds $delay
        }
    }

    if ($buildExitCode -ne 0) {
        throw @"
EXE build failed after $MaxAttempts attempts (exit code $buildExitCode).
If the output shows a timeout while downloading NSIS, verify access to:
https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip
On a proxied network, set HTTPS_PROXY (and HTTP_PROXY when required) before running this script. Tauri caches a successful tool download, so rerunning the command will reuse it.
"@
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
