@echo off
TITLE Yimly Sync Monitor - Setup Engine
setlocal enabledelayedexpansion

echo ==============================================
echo     Yimly Sync Monitor - Setup Engine
echo ==============================================
echo.

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"
cd /d "%APP_ROOT%"

echo [1/6] Detecting Application Root...
echo APP_ROOT: %APP_ROOT%
echo.

echo [2/6] Checking Python 3.10 environment...
set "PYTHON_EXE=%APP_ROOT%\python_env\Scripts\python.exe"

if exist "%PYTHON_EXE%" (
    echo Found existing Python environment at: %PYTHON_EXE%
) else (
    echo Creating Python 3.10 virtual environment...
    py -3.10 -m venv "%APP_ROOT%\python_env" >nul 2>&1
    if errorlevel 1 (
        python3.10 -m venv "%APP_ROOT%\python_env" >nul 2>&1
    )
    if errorlevel 1 (
        python -m venv "%APP_ROOT%\python_env" >nul 2>&1
    )
    if not exist "%PYTHON_EXE%" (
        echo [NOTICE] Downloading portable Python 3.10.11 runtime...
        powershell -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip' -OutFile '%APP_ROOT%\python_embed.zip'"
        if errorlevel 1 goto :py_error
        powershell -Command "Expand-Archive -Path '%APP_ROOT%\python_embed.zip' -DestinationPath '%APP_ROOT%\python_env' -Force"
        if errorlevel 1 goto :py_error
        del "%APP_ROOT%\python_embed.zip" >nul 2>&1
        mkdir "%APP_ROOT%\python_env\Scripts" >nul 2>&1
        copy "%APP_ROOT%\python_env\python.exe" "%APP_ROOT%\python_env\Scripts\python.exe" >nul 2>&1
        echo import site >> "%APP_ROOT%\python_env\python310._pth"
        powershell -Command "Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile '%APP_ROOT%\python_env\get-pip.py'"
        if errorlevel 1 goto :py_error
        "%PYTHON_EXE%" "%APP_ROOT%\python_env\get-pip.py" --no-warn-script-location
        if errorlevel 1 goto :py_error
    )
)

if not exist "%PYTHON_EXE%" (
    goto :py_error
)

echo.
echo [3/6] Upgrading pip, setuptools, wheel...
"%PYTHON_EXE%" -m pip install --upgrade pip setuptools wheel --no-warn-script-location
if errorlevel 1 goto :py_error

echo.
echo [4/6] Installing pinned AI dependencies (PyTorch cu126, WhisperX 3.8.6, Demucs 4.1.0)...
"%PYTHON_EXE%" -m pip install -r "%APP_ROOT%\requirements.txt" --no-warn-script-location
if errorlevel 1 goto :py_error

echo.
echo [5/6] Checking Node.js dependencies...
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js / npm not found in PATH. Please install Node.js before running setup.
    goto :node_error
)
call npm install
if errorlevel 1 goto :node_error

echo.
echo [6/6] Running System Verification...
for /f "tokens=*" %%i in ('""%PYTHON_EXE%" -c "import sys; print(sys.version.split()[0])""') do set "PY_VER=%%i"
for /f "tokens=*" %%i in ('""%PYTHON_EXE%" -c "import torch; print(torch.__version__)""') do set "TORCH_VER=%%i"
for /f "tokens=*" %%i in ('""%PYTHON_EXE%" -c "import whisperx; print(whisperx.__version__)""') do set "WX_VER=%%i"
for /f "tokens=*" %%i in ('""%PYTHON_EXE%" -c "import demucs; print(getattr(demucs, '__version__', '4.1.0'))""') do set "DEM_VER=%%i"
for /f "tokens=*" %%i in ('""%PYTHON_EXE%" -c "import torch; print(torch.cuda.is_available())""') do set "CUDA_AVAIL=%%i"
for /f "tokens=*" %%i in ('""%PYTHON_EXE%" -c "import torch; print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None')""') do set "GPU_NAME=%%i"

REM Verify split.py and align.py launch cleanly
"%PYTHON_EXE%" "%APP_ROOT%\split.py" --help >nul 2>&1
if errorlevel 1 (
    echo [ERROR] split.py failed to launch.
    goto :verify_error
)
"%PYTHON_EXE%" "%APP_ROOT%\align.py" --help >nul 2>&1
if errorlevel 1 (
    echo [ERROR] align.py failed to launch.
    goto :verify_error
)

echo.
echo ==============================================
echo      Yimly Sync Monitor - SETUP COMPLETE
echo ==============================================
echo.
echo Python:    %PY_VER%
echo PyTorch:   %TORCH_VER%
echo WhisperX:  %WX_VER%
echo Demucs:    %DEM_VER%
echo CUDA:      %CUDA_AVAIL% (%GPU_NAME%)
echo.
echo All required dependencies installed successfully.
echo Run start.bat to launch Yimly Sync Monitor.
echo ==============================================
pause
exit /b 0

:py_error
echo.
echo ==============================================
echo     Yimly Sync Monitor - SETUP FAILED
echo ==============================================
echo.
echo Python environment creation or package installation failed.
echo Setup was NOT completed successfully.
echo ==============================================
pause
exit /b 1

:node_error
echo.
echo ==============================================
echo     Yimly Sync Monitor - SETUP FAILED
echo ==============================================
echo.
echo Node dependency installation failed.
echo Setup was NOT completed successfully.
echo ==============================================
pause
exit /b 1

:verify_error
echo.
echo ==============================================
echo     Yimly Sync Monitor - SETUP FAILED
echo ==============================================
echo.
echo System verification failed for split.py or align.py.
echo Setup was NOT completed successfully.
echo ==============================================
pause
exit /b 1
