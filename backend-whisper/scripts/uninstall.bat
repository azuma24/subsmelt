@echo off
REM Remove the SubsmeltWhisper Windows Service (leaves files + config in place).
setlocal
set "INSTALL_DIR=%~dp0"
set "NSSM=%INSTALL_DIR%nssm.exe"
set "SERVICE=SubsmeltWhisper"

if not exist "%NSSM%" (
    echo [!] nssm.exe not found next to uninstall.bat.
    exit /b 1
)

"%NSSM%" stop %SERVICE%
"%NSSM%" remove %SERVICE% confirm
echo [+] %SERVICE% removed.
endlocal
