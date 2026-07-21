@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >/dev/null
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
cd /d E:\opencode\tech-proposal-studio\src-tauri
cargo check 2>&1
