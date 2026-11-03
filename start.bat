@echo off
rem ParallelRoom launcher (double-click to run)
rem First run installs dependencies; if the Electron binary is missing it retries via npmmirror.
setlocal
cd /d "%~dp0"

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

if exist "%ELECTRON_EXE%" goto run

echo [!] Electron not found, installing dependencies (first run may take a few minutes)...
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [x] npm not found. Please install Node.js first: https://nodejs.org/
  pause
  exit /b 1
)

call npm.cmd install --no-audit --no-fund
if exist "%ELECTRON_EXE%" goto run

echo [i] Electron binary missing, retrying with npmmirror...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not exist "node_modules\electron\install.js" (
  echo [x] node_modules is incomplete. Run "npm install" manually.
  pause
  exit /b 1
)
call node "node_modules\electron\install.js"

if not exist "%ELECTRON_EXE%" (
  echo [x] Electron install failed. Run "npm install" manually.
  pause
  exit /b 1
)

:run
start "" "%ELECTRON_EXE%" . %*
exit /b 0
