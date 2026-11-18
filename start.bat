@echo off
rem Engineering AI Console - Windows launcher.
rem
rem No arguments (double-click): verify Python 3.9+, then start the local service in the
rem background through pythonw.exe (no console window) and close this CMD window at once.
rem The service opens the browser by itself and stops about 5 seconds after the last console
rem tab is closed, so there is no resident black window and no Ctrl+C -> Y.
rem
rem With arguments (for example start.bat --port 18770 or start.bat --foreground): stay in
rem the foreground with python.exe so the real Python output and errors remain visible.
setlocal
cd /d "%~dp0"

python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
if not errorlevel 1 goto have_python

py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
if not errorlevel 1 goto have_py_launcher

goto no_python

:have_python
set "PYTHON_CMD=python"
goto dispatch

:have_py_launcher
set "PYTHON_CMD=py -3"
goto dispatch

:dispatch
if not "%~1"=="" goto foreground
goto background

:background
set "PYTHONW="
for /f "delims=" %%I in ('%PYTHON_CMD% -c "import os,sys;sys.stdout.write(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))"') do set "PYTHONW=%%I"
if not defined PYTHONW goto background_foreground
if not exist "%PYTHONW%" goto background_foreground
rem Detached, no console window: the window you double-clicked closes right here.
start "" "%PYTHONW%" "%~dp0server.py" --auto-exit
exit /b 0

:background_foreground
rem pythonw.exe is not shipped with this interpreter: keep the visible window, still auto-stop.
%PYTHON_CMD% server.py --auto-exit
set "SERVER_EXIT=%errorlevel%"
if not "%SERVER_EXIT%"=="0" goto server_failed
exit /b 0

:foreground
%PYTHON_CMD% server.py %*
set "SERVER_EXIT=%errorlevel%"
if not "%SERVER_EXIT%"=="0" goto server_failed
exit /b 0

:server_failed
echo.
echo server.py failed to start or stopped unexpectedly (exit code %SERVER_EXIT%).
echo The Python error above is kept on screen. This console needs the local service for server mode.
echo For static direct mode, open dist\index.html in a browser.
exit /b 1

:no_python
echo.
echo Python 3.9 or newer was not found on this computer.
echo Opening the prebuilt static console in pure static direct mode...
echo In this mode channels and API keys are kept in this browser only.
start "" "%~dp0dist\index.html"
exit /b 0
