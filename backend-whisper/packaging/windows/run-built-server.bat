@echo off
REM ============================================================================
REM  Launch the locally-built Whisper backend WITHOUT installing it (plan Phase 6
REM  smoke test). Run build-local.bat first so dist\whisper-server\ exists.
REM
REM  Prompts for the bind address and port, then starts the server. Verify in a
REM  browser at  http://<host>:<port>/health  and  /version .
REM ============================================================================
setlocal
set "EXE=%~dp0..\..\dist\whisper-server\run_server.exe"
if not exist "%EXE%" (
    echo ERROR: %EXE% not found.
    echo Run build-local.bat first to build the bundle.
    pause
    exit /b 1
)

echo.
echo Select bind address:
echo    [1] 127.0.0.1   this machine only ^(default, safest^)
echo    [2] 0.0.0.0     all interfaces ^(LAN / remote access^)
set "HOSTCHOICE="
set /p HOSTCHOICE="Enter 1 or 2 [1]: "
if "%HOSTCHOICE%"=="2" (set "SUBSMELT_WHISPER_HOST=0.0.0.0") else (set "SUBSMELT_WHISPER_HOST=127.0.0.1")

set "PORTIN="
set /p PORTIN="Port [8001]: "
if "%PORTIN%"=="" (set "SUBSMELT_WHISPER_PORT=8001") else (set "SUBSMELT_WHISPER_PORT=%PORTIN%")

REM --- LAN bind: warn + offer a token + remind about the firewall rule ---
if not "%SUBSMELT_WHISPER_HOST%"=="0.0.0.0" goto launch
echo.
echo WARNING: 0.0.0.0 exposes this server to your whole network.
echo Set a token to require auth on /preflight + /transcribe routes.
echo Leave blank to run UNAUTHENTICATED (anyone on the LAN can use it).
set "TOKIN="
set /p TOKIN="Token (optional): "
if not "%TOKIN%"=="" set "SUBSMELT_WHISPER_TOKEN=%TOKIN%"
echo.
echo If you cannot reach it from another machine, allow the port in the firewall
echo (run once, in an ADMIN Command Prompt):
echo    netsh advfirewall firewall add rule name="SubSmelt Whisper" dir=in action=allow protocol=TCP localport=%SUBSMELT_WHISPER_PORT%

:launch
echo.
echo Starting Whisper backend on http://%SUBSMELT_WHISPER_HOST%:%SUBSMELT_WHISPER_PORT%   (Ctrl+C to stop)
echo   health:  http://%SUBSMELT_WHISPER_HOST%:%SUBSMELT_WHISPER_PORT%/health
echo   version: http://%SUBSMELT_WHISPER_HOST%:%SUBSMELT_WHISPER_PORT%/version
echo.
"%EXE%"
pause
