; =============================================================================
; SubSmelt Whisper Backend — Inno Setup installer (plan Phase 3 "Installer")
;
; WINDOWS-BUILD-ONLY. Compile with the Inno Setup Compiler (ISCC.exe) on a
; Windows build host AFTER the PyInstaller onedir bundle exists:
;
;     iscc packaging\windows\installer.iss
;
; This script CANNOT be compiled or run on macOS/Linux and is heavily commented
; because it cannot be tested in this environment.
;
; What it does (plan Phase 3):
;   * Stops a running SubSmeltWhisper service before files are copied (upgrade).
;   * Installs the --onedir output (dist\whisper-server\) into Program Files.
;   * Bundles + silently installs the VC++ redistributable.
;   * Runs a driver-version / hardware PRE-CHECK gate (Phase 3a provisioning).
;   * Registers the Windows Service (install-service.ps1), which writes the
;     settings and a fresh token to C:\ProgramData\SubSmelt\config.json, and
;     fails the install visibly when that script fails.
;   * Adds a Windows Firewall rule for the chosen port (private/domain only).
;   * Shows the backend URL and token on the finish page.
;   * Provides a clean uninstaller (uninstall-service.ps1 + firewall removal).
;
; Models are NOT bundled (plan Phase 3/3a). First run uses the model manager.
; =============================================================================

#define MyAppName "SubSmelt Whisper Backend"
; Version is overridable from CI: `iscc /DMyAppVersion=1.2.3 installer.iss`.
; The #ifndef guard lets a command-line /D win; falls back to this default for
; local manual compiles.
#ifndef MyAppVersion
  #define MyAppVersion "0.6.8"
#endif
#define MyAppPublisher "SubSmelt"
#define MyServiceName "SubSmeltWhisper"
#define MyDefaultPort "8001"
#define MyFirewallRule "SubSmelt Whisper Backend"

[Setup]
AppId={{B7E1B0C2-9D3A-4E55-9B2E-5A1F2C3D4E5F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\SubSmelt\WhisperBackend
DefaultGroupName=SubSmelt
; Service + firewall + driver work requires admin.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=SubSmeltWhisperBackend-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; The onedir bundle + CUDA DLLs are large (~1-2 GB, plan §4 risk #7).
DiskSpanning=no

[Files]
; -- The PyInstaller onedir bundle. Build it first; path is relative to this .iss.
;    "dist\whisper-server\*" contains run_server.exe + DLLs + app\ + ffmpeg.exe.
;    It also carries nemo-speech\ (the NeMo-Speech CUDA runtime for Nemotron ASR).
Source: "..\..\dist\whisper-server\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

; -- Service install/uninstall scripts (copied next to the exe so they find it).
Source: "install-service.ps1";   DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall-service.ps1"; DestDir: "{app}"; Flags: ignoreversion

; -- VC++ redistributable: DROP-IN REQUIRED.
;    Download "vc_redist.x64.exe" from Microsoft and place it at
;    packaging\windows\vendor\vc_redist.x64.exe before compiling.
;    'deleteafterinstall' keeps it out of the installed dir.
Source: "vendor\vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: VCRedistBundled

[Icons]
; The GUI and tray controllers ship inside the bundle (built by
; windows-whisper-build.yml). Without these entries they install with nothing
; pointing at them, so a user has no way to find the app they are meant to use.
; Both are gated on the exe actually being present: a bundle built locally with
; -SkipTray has neither, and a shortcut to a missing file is worse than none.
Name: "{group}\{#MyAppName}";           Filename: "{app}\whisper-gui.exe";  Check: GuiBundled
Name: "{commondesktop}\{#MyAppName}";   Filename: "{app}\whisper-gui.exe";  Check: GuiBundled; Tasks: desktopicon
Name: "{group}\Whisper Tray";           Filename: "{app}\whisper-tray.exe"; Check: TrayBundled
; config.json is readable by administrators only (it holds the token), so the
; editor is started through a UAC prompt.
Name: "{group}\Open Whisper Config";    Filename: "powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -Command ""Start-Process notepad.exe -Verb RunAs -ArgumentList '{commonappdata}\SubSmelt\config.json'"""
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Tasks]
; No Check here: [Tasks] is evaluated while the wizard runs, BEFORE [Files]
; copies anything, so a FileExists probe against {app} would always be False and
; the checkbox would never appear. The [Icons] entry above stays gated instead,
; so ticking this on a bundle without the GUI simply creates no shortcut.
Name: "desktopicon"; Description: "Create a desktop shortcut for the control window"; GroupDescription: "Shortcuts:"

[Run]
; The VC++ runtime, service registration and firewall rule run from [Code]
; (CurStepChanged ssPostInstall) so their exit codes are checked; a [Run] entry
; cannot fail the install. Only the finish-page checkbox lives here. It runs
; elevated on purpose: backend-info.txt is readable by administrators only.
Filename: "notepad.exe"; Parameters: """{commonappdata}\SubSmelt\backend-info.txt"""; \
    Description: "Open backend-info.txt (backend URL and token)"; Flags: postinstall nowait skipifsilent; Check: BackendInfoWritten

[UninstallRun]
; Remove the service first (before files are deleted).
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"" -ServiceName ""{#MyServiceName}"""; \
    RunOnceId: "RemoveService"; Flags: runhidden waituntilterminated
; Remove the firewall rule.
Filename: "netsh.exe"; \
    Parameters: "advfirewall firewall delete rule name=""{#MyFirewallRule}"""; \
    RunOnceId: "RemoveFirewall"; Flags: runhidden waituntilterminated

[Code]
var
  PortPage: TInputQueryWizardPage;

{ ---- Wizard: ask for the service port ---- }
procedure InitializeWizard;
begin
  PortPage := CreateInputQueryPage(wpSelectDir,
    'Network Port',
    'Which TCP port should the Whisper backend listen on?',
    'SubSmelt will connect to this port. The installer opens it in Windows Firewall.');
  PortPage.Add('Port:', False);
  PortPage.Values[0] := '{#MyDefaultPort}';
end;

function GetPort(Param: string): string;
begin
  Result := PortPage.Values[0];
  if Trim(Result) = '' then
    Result := '{#MyDefaultPort}';
end;

{ ---- True when the optional controller exes made it into the bundle ---- }
function GuiBundled: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\whisper-gui.exe'));
end;

function TrayBundled: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\whisper-tray.exe'));
end;

function BackendInfoWritten: Boolean;
begin
  Result := FileExists(ExpandConstant('{commonappdata}\SubSmelt\backend-info.txt'));
end;

{ ---- True if the bundled VC++ redist was dropped in at build time ---- }
function VCRedistBundled: Boolean;
begin
  // The bundled vc_redist exists only if the [Files] entry copied it; that entry
  // is gated on this same check. We return True and let the [Files] 'Check'
  // decide; a missing source file at COMPILE time makes ISCC error, which is the
  // desired "drop it in" enforcement. (Note: avoid Inno {-constants in { } block
  // comments — the first } closes the comment early and breaks compilation.)
  Result := True;
end;

{ ---- Stop a running service so an upgrade does not hit locked files ----
  net stop waits for the service to report STOPPED; the loop afterwards covers
  a service that was still STOP_PENDING when net gave up. }
procedure StopExistingService;
var
  ResultCode: Integer;
  Attempt: Integer;
begin
  if not Exec('net.exe', 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Exit;
  Log(Format('net stop {#MyServiceName} exited %d', [ResultCode]));
  for Attempt := 1 to 30 do
  begin
    if Exec('cmd.exe', '/C sc.exe query {#MyServiceName} | find "STOPPED"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
      Exit;
    if Exec('cmd.exe', '/C sc.exe query {#MyServiceName} | find "1060"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
      Exit;  { 1060: not installed }
    Sleep(1000);
  end;
  Log('{#MyServiceName} did not reach STOPPED within 30 s; continuing.');
end;

{ =========================================================================
  Phase 3a PROVISIONING PRE-CHECK (driver / hardware gate).

  PrepareToInstall runs before any file is copied. We call the provisioning
  "doctor" to verify the NVIDIA driver meets the pinned minimum for the CUDA 12 /
  cuDNN 9 runtime CTranslate2 needs. The detection logic lives in the Phase 3a
  provision module (plan §Phase 3a "Implementation notes").

  INTEGRATION POINT / TODO (Phase 3a):
    Replace the placeholder below with a real call once the provision module
    ships. Two supported shapes:
      (a) python -m app.provision doctor --json     (when Python is on PATH), or
      (b) a bundled provision.exe doctor --json      (preferred for installers).
    The doctor should exit 0 = OK, non-zero = blocking issue, and print JSON the
    installer can parse. For now we run it best-effort and NEVER hard-block:
    the plan requires a "Skip -> CPU-only mode" escape so a driver step never
    bricks the install.
  ========================================================================= }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  DoctorExe: String;
begin
  Result := '';  { empty string => proceed with install }
  NeedsRestart := False;

  StopExistingService;

  { TODO(Phase 3a): point this at the bundled provision.exe once it exists.
    Until then we look for it next to the source bundle; if absent, we skip the
    gate rather than block (CPU-only mode is always allowed). }
  DoctorExe := ExpandConstant('{src}\provision.exe');
  if FileExists(DoctorExe) then
  begin
    if not Exec(DoctorExe, 'doctor --quiet', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      { Could not even launch the doctor — warn but continue (non-fatal). }
      Log('Provisioning doctor failed to launch; continuing (CPU-only fallback available).');
      Exit;
    end;
    if ResultCode <> 0 then
    begin
      { Driver missing/too old. Inform the user but allow continue -> CPU-only.
        A future revision can offer the guided driver install from Phase 3a here. }
      if MsgBox('GPU prerequisites are not fully met (NVIDIA driver missing or too old).' + #13#10 +
                'You can continue and run in CPU-only mode, then fix the driver later' + #13#10 +
                'via the tray app''s "Run diagnostics".' + #13#10#13#10 +
                'Continue installation?', mbConfirmation, MB_YESNO) = IDNO then
        Result := 'Installation cancelled: resolve the NVIDIA driver and re-run setup.';
    end;
  end
  else
    Log('provision.exe not found; skipping driver pre-check (Phase 3a integration pending).');
end;

{ ---- VC++ runtime, silent. /norestart so we don't reboot mid-install. ---- }
procedure InstallVCRedist;
var
  ResultCode: Integer;
  Redist: String;
begin
  Redist := ExpandConstant('{tmp}\vc_redist.x64.exe');
  if not FileExists(Redist) then
    Exit;
  if not Exec(Redist, '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('vc_redist.x64.exe failed to launch')
  else
    Log(Format('vc_redist.x64.exe exited %d', [ResultCode]));
end;

{ ---- Register the service through install-service.ps1 ----
  -GenerateToken: a fresh install is never tokenless; the script keeps a token
  that config.json already holds, so an upgrade does not change the key.
  The script's output goes to install-service.log (it never prints the token
  when -InfoFile is given); a non-zero exit is shown to the user instead of
  letting Setup report success. }
procedure RegisterService;
var
  ResultCode: Integer;
  DataDir, LogFile, Params: String;
begin
  DataDir := ExpandConstant('{commonappdata}\SubSmelt');
  LogFile := DataDir + '\logs\install-service.log';
  Params := '/C ""powershell.exe" -NoProfile -ExecutionPolicy Bypass'
    + ' -File "' + ExpandConstant('{app}\install-service.ps1') + '"'
    + ' -ExePath "' + ExpandConstant('{app}\run_server.exe') + '"'
    + ' -ServiceName "{#MyServiceName}"'
    + ' -Port ' + GetPort('')
    + ' -Version "{#MyAppVersion}"'
    + ' -DataDir "' + DataDir + '"'
    + ' -ModelDir "' + DataDir + '\models"'
    + ' -MediaRoot "' + DataDir + '\media"'
    + ' -InfoFile "' + DataDir + '\backend-info.txt"'
    + ' -GenerateToken'
    + ' > "' + LogFile + '" 2>&1"';
  if not Exec('cmd.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Could not launch install-service.ps1. The backend service was NOT registered.' + #13#10 +
           'Run install-service.ps1 from an elevated PowerShell in ' + ExpandConstant('{app}') + '.',
           mbError, MB_OK);
    Exit;
  end;
  Log(Format('install-service.ps1 exited %d', [ResultCode]));
  if ResultCode <> 0 then
    MsgBox(Format('Registering the backend service failed (exit code %d).', [ResultCode]) + #13#10#13#10 +
           'See ' + LogFile + ' for details, then run install-service.ps1 from an elevated PowerShell in '
           + ExpandConstant('{app}') + '.', mbError, MB_OK);
end;

{ ---- Firewall: delete any rule with our name first, so an upgrade does not
  leave one rule per install. Private and domain profiles only: a backend on a
  public network should not be reachable from it. ---- }
procedure AddFirewallRule;
var
  ResultCode: Integer;
begin
  Exec('netsh.exe', 'advfirewall firewall delete rule name="{#MyFirewallRule}"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if not Exec('netsh.exe', 'advfirewall firewall add rule name="{#MyFirewallRule}" dir=in action=allow protocol=TCP localport='
      + GetPort('') + ' profile=private,domain', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('netsh failed to launch')
  else
    Log(Format('netsh add rule exited %d', [ResultCode]));
end;

{ Order matters: VC++ runtime -> service registration -> firewall rule. The
  driver pre-check ran earlier (PrepareToInstall). }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    ForceDirectories(ExpandConstant('{commonappdata}\SubSmelt'));
    ForceDirectories(ExpandConstant('{commonappdata}\SubSmelt\models'));
    ForceDirectories(ExpandConstant('{commonappdata}\SubSmelt\media'));
    ForceDirectories(ExpandConstant('{commonappdata}\SubSmelt\logs'));
    InstallVCRedist;
    RegisterService;
    AddFirewallRule;
  end;
end;

{ ---- Finish page: show the connection details install-service.ps1 wrote ---- }
procedure CurPageChanged(CurPageID: Integer);
var
  Info: AnsiString;
begin
  if CurPageID = wpFinished then
  begin
    if LoadStringFromFile(ExpandConstant('{commonappdata}\SubSmelt\backend-info.txt'), Info) then
      WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 + String(Info)
    else
      WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
        'The backend service was not registered. See ' +
        ExpandConstant('{commonappdata}\SubSmelt\logs\install-service.log') + '.';
  end;
end;
