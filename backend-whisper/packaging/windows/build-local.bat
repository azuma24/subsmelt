@echo off
REM ============================================================================
REM  SubSmelt Whisper backend - one-click local build (plan Phase 6).
REM
REM  Copy the whole repo to this Windows machine, then DOUBLE-CLICK this file.
REM  It builds the PyInstaller bundle and (if Inno Setup is installed) the
REM  installer, fetching ffmpeg + vc_redist automatically. Model weights are
REM  NOT bundled - download them after install via the in-app model manager.
REM
REM  Prereqs: Python 3.10-3.13 on PATH. Inno Setup is optional (only needed to
REM  produce the .exe installer; the bundle builds without it).
REM
REM  Pass-through flags work too, e.g. from a terminal:
REM      build-local.bat -Run
REM      build-local.bat -Version 0.5.0
REM      build-local.bat -Clean
REM ============================================================================
setlocal
REM Prefer PowerShell 7 (pwsh) when present; fall back to Windows PowerShell.
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
    set "PS=pwsh"
) else (
    set "PS=powershell"
)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-local.ps1" %*
echo.
echo ============================================================================
echo  Build script finished. Review the output above.
echo  Test the server without installing:  run-built-server.bat
echo ============================================================================
pause
