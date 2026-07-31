@echo off
setlocal

call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (
  echo Failed to initialize the Visual Studio x64 build environment.
  exit /b 1
)

for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:":1420 .*LISTENING"') do (
  echo Port 1420 is already in use by PID %%P.
  echo Stop the existing dev server before running this script again.
  echo You can kill it with:  powershell -ExecutionPolicy Bypass -File "%~dp0kill-port.ps1"
  exit /b 1
)

where cl
where link
cd /d "%~dp0.."
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
pnpm tauri dev
