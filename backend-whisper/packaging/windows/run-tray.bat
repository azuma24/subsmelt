@echo off
REM ============================================================================
REM  Launch the SubSmelt Whisper system-tray controller (standalone mode).
REM  It starts run_server.exe and gives you a tray icon to Start / Stop /
REM  Restart / open the health page / open logs / Quit (which stops the server).
REM
REM  Run build-local.bat first (it builds whisper-tray.exe next to run_server.exe).
REM  Falls back to the build venv's Python if the exe isn't there yet.
REM
REM  Remote/LAN tip: set a token first so the server binds 0.0.0.0 (all
REM  interfaces) instead of localhost, and open the firewall port:
REM      set SUBSMELT_WHISPER_TOKEN=choose-a-secret
REM      netsh advfirewall firewall add rule name="SubSmelt Whisper" dir=in action=allow protocol=TCP localport=8001
REM ============================================================================
setlocal
set "TRAY=%~dp0..\..\dist\whisper-server\whisper-tray.exe"
if exist "%TRAY%" (
    start "" "%TRAY%" --standalone
    exit /b 0
)
echo whisper-tray.exe not found - falling back to the build venv.
set "VENVPY=%~dp0..\..\.venv-build\Scripts\python.exe"
if exist "%VENVPY%" (
    "%VENVPY%" -m pip install pystray pillow
    "%VENVPY%" "%~dp0tray\whisper_tray.py" --standalone
) else (
    echo ERROR: run build-local.bat first to build whisper-tray.exe / the venv.
    pause
    exit /b 1
)
