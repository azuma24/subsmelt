@echo off
REM ============================================================================
REM  Launch the SubSmelt Whisper native GUI app (Tkinter window + system tray).
REM  A real window to pick host/port/token and Start/Stop/Restart the server,
REM  read /health, and open logs/config. CLOSING the window hides it to the
REM  system tray (server keeps running); the tray icon restores it or quits.
REM
REM  Run build-local.bat first (it builds whisper-gui.exe next to run_server.exe).
REM  Falls back to the build venv's Python if the exe isn't there yet.
REM ============================================================================
setlocal
set "GUI=%~dp0..\..\dist\whisper-server\whisper-gui.exe"
if exist "%GUI%" (
    start "" "%GUI%"
    exit /b 0
)
echo whisper-gui.exe not found - falling back to the build venv.
set "VENVPY=%~dp0..\..\.venv-build\Scripts\python.exe"
if exist "%VENVPY%" (
    "%VENVPY%" -m pip install pystray pillow
    "%VENVPY%" "%~dp0tray\whisper_gui.py"
) else (
    echo ERROR: run build-local.bat first to build whisper-gui.exe / the venv.
    pause
    exit /b 1
)
