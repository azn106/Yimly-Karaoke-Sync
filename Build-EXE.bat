@echo off
TITLE Yimly Sync Monitor - Build EXE Launcher
setlocal enabledelayedexpansion

echo =======================================================
echo        Yimly Sync Monitor - EXE Launcher Builder
echo =======================================================
echo.

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"
cd /d "%APP_ROOT%"

echo [1/5] Application Directory:
echo       "%APP_ROOT%"
echo.

echo [2/5] Verifying Project Prerequisites...
if not exist "%APP_ROOT%\start.bat" (
    if not exist "%APP_ROOT%\Start-YimlySync.bat" (
        echo [ERROR] start.bat not found in "%APP_ROOT%".
        echo Please ensure start.bat is present.
        goto :build_failed
    )
)
echo       [OK] start.bat verified.

if not exist "%APP_ROOT%\mic.svg" (
    echo [WARNING] mic.svg not found in project root.
) else (
    echo       [OK] mic.svg verified.
)

if not exist "%APP_ROOT%\YimlyLauncher.ps1" (
    echo [ERROR] YimlyLauncher.ps1 not found in "%APP_ROOT%".
    goto :build_failed
)
echo       [OK] YimlyLauncher.ps1 verified.
echo.

echo [3/5] Verifying / Generating Yimly.ico...
if not exist "%APP_ROOT%\Yimly.ico" (
    echo       Yimly.ico not found. Generating from mic.svg...
    if exist "%APP_ROOT%\scripts\generate-ico.js" (
        node "%APP_ROOT%\scripts\generate-ico.js"
    )
)
if exist "%APP_ROOT%\Yimly.ico" (
    echo       [OK] Yimly.ico is ready.
) else (
    echo [WARNING] Yimly.ico could not be generated. Proceeding with default icon.
)
echo.

echo [4/5] Compiling "Yimly Sync Monitor.exe"...
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%\scripts\build-exe.ps1" -AppRoot "%APP_ROOT%"
if errorlevel 1 goto :build_failed

echo.
echo [5/5] Verifying Final Binary...
if exist "%APP_ROOT%\Yimly Sync Monitor.exe" (
    echo.
    echo =======================================================
    echo  [SUCCESS] "Yimly Sync Monitor.exe" built successfully!
    echo =======================================================
    echo.
    echo Output Location:
    echo   "%APP_ROOT%\Yimly Sync Monitor.exe"
    echo.
    echo Embedded Icon:
    echo   Yimly.ico (Mic Artwork)
    echo.
    echo You can now double-click "Yimly Sync Monitor.exe" to launch Yimly.
    echo =======================================================
    pause
    exit /b 0
) else (
    echo [ERROR] "Yimly Sync Monitor.exe" was not created.
    goto :build_failed
)

:build_failed
echo.
echo =======================================================
echo  [FAILED] Failed to build Yimly Sync Monitor.exe
echo =======================================================
pause
exit /b 1
