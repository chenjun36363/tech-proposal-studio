@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (
  echo VCVARS_FAILED
  exit /b 1
)
where cl
where link
cd /d E:\opencode\tech-proposal-studio
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
pnpm tauri dev
