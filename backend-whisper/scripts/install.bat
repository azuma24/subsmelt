@echo off
REM Unattended install: register subsmelt-whisper as a Windows Service.
REM Usage (from an Administrator cmd.exe inside the extracted zip):
REM     install.bat
REM Requires nssm.exe next to this script.

setlocal

set "INSTALL_DIR=%~dp0"
set "NSSM=%INSTALL_DIR%nssm.exe"
set "EXE=%INSTALL_DIR%subsmelt-whisper.exe"
set "SERVICE=SubsmeltWhisper"
set "CONFIG_DIR=%ProgramData%\SubsmeltWhisper"

if not exist "%NSSM%" (
    echo [!] nssm.exe not found next to install.bat. Download nssm and place it here.
    exit /b 1
)
if not exist "%EXE%" (
    echo [!] subsmelt-whisper.exe not found. Run build-windows.ps1 first.
    exit /b 1
)

if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

"%NSSM%" install %SERVICE% "%EXE%" serve
"%NSSM%" set %SERVICE% AppDirectory "%INSTALL_DIR%"
"%NSSM%" set %SERVICE% AppStdout "%CONFIG_DIR%\service.log"
"%NSSM%" set %SERVICE% AppStderr "%CONFIG_DIR%\service.log"
"%NSSM%" set %SERVICE% Start SERVICE_AUTO_START
"%NSSM%" start %SERVICE%

echo.
echo [+] %SERVICE% installed and started.
echo     Config: %CONFIG_DIR%\config.ini
echo     Logs:   %CONFIG_DIR%\service.log
echo.
echo Open %CONFIG_DIR%\config.ini to copy the generated API key.
endlocal
