@echo off
TITLE Yimly Sync Monitor
echo ==============================================
echo       Starting Yimly Sync Monitor
echo ==============================================

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"
cd /d "%APP_ROOT%"

echo [1/3] Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [2/3] Checking npm...
call npm -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm is not installed or not in PATH.
    pause
    exit /b 1
)

echo [3/3] Starting development server...
echo.
set "PATH=%APP_ROOT%\node_modules\.bin;%PATH%"
echo Launching browser in a few seconds...
start /B cmd /c "ping localhost -n 6 > nul && start http://localhost:3000"
call npm run dev

echo.
echo ==============================================
echo [WARNING] Server stopped or crashed.
echo ==============================================
pause
