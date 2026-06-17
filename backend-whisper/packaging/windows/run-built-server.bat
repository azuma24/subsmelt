@echo off
REM ============================================================================
REM  Launch the locally-built Whisper backend WITHOUT installing it (plan Phase 6
REM  smoke test). Run build-local.bat first so dist\whisper-server\ exists.
REM
REM  Starts on http://127.0.0.1:8001 . Verify in a browser:
REM      http://127.0.0.1:8001/health    (ffmpeg, RAM, capabilities, GPUs)
REM      http://127.0.0.1:8001/version   (version + transport modes)
REM  Then open the SubSmelt app, point the Transcription backend URL at it, and
REM  use the model manager to download a model before transcribing.
REM
REM  Optional: set a token to require auth and bind to all interfaces:
REM      set SUBSMELT_WHISPER_TOKEN=mysecret
REM  Optional: write logs to a file (rotating):
REM      set SUBSMELT_WHISPER_LOG_FILE=%CD%\whisper.log
REM ============================================================================
setlocal
set "EXE=%~dp0..\..\dist\whisper-server\run_server.exe"
if not exist "%EXE%" (
    echo ERROR: %EXE% not found.
    echo Run build-local.bat first to build the bundle.
    pause
    exit /b 1
)
echo Starting Whisper backend on http://127.0.0.1:8001  (Ctrl+C to stop)
"%EXE%"
pause
