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
;   * On upgrade, before files are copied: stops and removes the
;     SubSmeltWhisper service older versions ran the backend as (aborting if it
;     will not stop), closes the tray, the window and any backend they started,
;     and deletes the previous program files so nothing from the old bundle
;     lingers. C:\ProgramData\SubSmelt is left in place: each user's first start
;     carries its host, port and key over.
;   * Installs the --onedir output (dist\whisper-server\) into Program Files.
;   * Bundles + silently installs the VC++ redistributable.
;   * Runs a driver-version / hardware PRE-CHECK gate (Phase 3a provisioning).
;   * The backend runs as the signed-in user, from %LOCALAPPDATA%\SubSmelt: an
;     all-users Startup shortcut opens the tray at sign-in, and the tray starts
;     the backend. Start, stop and restart never need administrator approval.
;   * Adds a Windows Firewall rule for run_server.exe (private/domain only), so
;     a port changed later needs no new rule.
;   * Provides a clean uninstaller (closes the apps, removes the firewall rule;
;     each user's own data is left alone).
;
; Models are NOT bundled (plan Phase 3/3a). First run uses the model manager.
; =============================================================================

#define MyAppName "SubSmelt Whisper Backend"
; Version is overridable from CI: `iscc /DMyAppVersion=1.2.3 installer.iss`.
; The #ifndef guard lets a command-line /D win; falls back to this default for
; local manual compiles.
#ifndef MyAppVersion
  #define MyAppVersion "0.8.0"
#endif
#define MyAppPublisher "SubSmelt"
#define MyServiceName "SubSmeltWhisper"
#define MyFirewallRule "SubSmelt Whisper Backend"

[Setup]
AppId={{B7E1B0C2-9D3A-4E55-9B2E-5A1F2C3D4E5F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\SubSmelt\WhisperBackend
DefaultGroupName=SubSmelt
; Program Files, the firewall rule and the driver check require admin.
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

; -- Removes the service an older version installed (also clears the machine
;    environment variables those versions set).
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
; Every user who signs in gets the tray, which starts that user's backend.
Name: "{commonstartup}\SubSmelt Whisper"; Filename: "{app}\whisper-tray.exe"; Check: TrayBundled
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Tasks]
; No Check here: [Tasks] is evaluated while the wizard runs, BEFORE [Files]
; copies anything, so a FileExists probe against {app} would always be False and
; the checkbox would never appear. The [Icons] entry above stays gated instead,
; so ticking this on a bundle without the GUI simply creates no shortcut.
Name: "desktopicon"; Description: "Create a desktop shortcut for the control window"; GroupDescription: "Shortcuts:"

[Run]
; The VC++ runtime and firewall rule run from [Code] (CurStepChanged
; ssPostInstall) so their exit codes are checked. These start the tray (which
; starts the backend) and the control window as the user who ran setup, not
; as the elevated installer: the backend must run as that user.
Filename: "{app}\whisper-tray.exe"; Description: "Start the backend now"; \
    Flags: postinstall nowait skipifsilent runasoriginaluser; Check: TrayBundled
Filename: "{app}\whisper-gui.exe"; Description: "Open the control window (backend URL and API key)"; \
    Flags: postinstall nowait skipifsilent runasoriginaluser; Check: GuiBundled

[UninstallRun]
; Close the tray, the window and every user's backend before the files go.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM whisper-tray.exe /IM whisper-gui.exe /IM run_server.exe"; \
    RunOnceId: "CloseApps"; Flags: runhidden waituntilterminated
; A service left by an older version, if any.
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"" -ServiceName ""{#MyServiceName}"" -KeepConfig"; \
    RunOnceId: "RemoveService"; Flags: runhidden waituntilterminated
; Remove the firewall rule.
Filename: "netsh.exe"; \
    Parameters: "advfirewall firewall delete rule name=""{#MyFirewallRule}"""; \
    RunOnceId: "RemoveFirewall"; Flags: runhidden waituntilterminated

[Code]
{ ---- True when the optional controller exes made it into the bundle ---- }
function GuiBundled: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\whisper-gui.exe'));
end;

function TrayBundled: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\whisper-tray.exe'));
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
  a service that was still STOP_PENDING when net gave up. False when it is still
  running after 30 s: copying over a live bundle fails on locked files or
  leaves a mix of old and new. }
function StopExistingService: Boolean;
var
  ResultCode: Integer;
  Attempt: Integer;
begin
  Result := True;
  if Exec('net.exe', 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log(Format('net stop {#MyServiceName} exited %d', [ResultCode]));
  for Attempt := 1 to 30 do
  begin
    if Exec('cmd.exe', '/C sc.exe query {#MyServiceName} | find "STOPPED"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
      Exit;
    if Exec('cmd.exe', '/C sc.exe query {#MyServiceName} | find "1060"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
      Exit;  { 1060: not installed }
    Sleep(1000);
  end;
  Log('{#MyServiceName} did not reach STOPPED within 30 s.');
  Result := False;
end;

{ ---- Remove the service older versions ran the backend as ----
  The backend now runs as the signed-in user. Deleting the stopped service is
  enough; its data in C:\ProgramData\SubSmelt stays for each user's first start
  to carry host, port and key over. 1060 means there was no service. }
procedure RemoveOldService;
var
  ResultCode: Integer;
begin
  if Exec('sc.exe', 'delete {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log(Format('sc.exe delete {#MyServiceName} exited %d (1060 = not installed)', [ResultCode]));
end;

{ ---- Close the control apps and any server they started ----
  whisper-gui.exe and whisper-tray.exe run in the user's session and lock their
  own exes; a standalone run_server.exe they launched locks the bundle and keeps
  holding the port. The service is already stopped, so every run_server.exe
  left is one of those. }
procedure StopControlApps;
var
  ResultCode: Integer;
begin
  if Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM whisper-gui.exe /IM whisper-tray.exe /IM run_server.exe',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log(Format('taskkill exited %d (128 = none running)', [ResultCode]));
  Sleep(1000);  { let Windows release the handles }
end;

{ ---- Delete the previous program files ----
  The [Files] section only copies over the app folder, so a DLL or module the new bundle dropped
  would stay behind and could be loaded instead of the right one. Only runs
  when that folder holds run_server.exe, so a folder that is not ours is never
  emptied, and keeps Inno's own unins* files so the uninstaller still works.
  Returns the path it could not delete, or '' on success. }
function RemoveOldProgramFiles: String;
var
  Dir: String;
  Path: String;
  FindRec: TFindRec;
  Deleted: Boolean;
begin
  Result := '';
  Dir := ExpandConstant('{app}');
  if not FileExists(Dir + '\run_server.exe') then
    Exit;
  if not FindFirst(Dir + '\*', FindRec) then
    Exit;
  try
    repeat
      if (FindRec.Name <> '.') and (FindRec.Name <> '..') and (Pos('unins', Lowercase(FindRec.Name)) <> 1) then
      begin
        Path := Dir + '\' + FindRec.Name;
        if DirExists(Path) then
          Deleted := DelTree(Path, True, True, True)
        else
          Deleted := DeleteFile(Path);
        if not Deleted then
        begin
          Result := Path;
          Exit;
        end;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
  Log('Removed the previous program files from ' + Dir);
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
  FailedPath: String;
begin
  Result := '';  { empty string => proceed with install }
  NeedsRestart := False;

  { TODO(Phase 3a): point this at the bundled provision.exe once it exists.
    Until then we look for it next to the source bundle; if absent, we skip the
    gate rather than block (CPU-only mode is always allowed). }
  DoctorExe := ExpandConstant('{src}\provision.exe');
  if FileExists(DoctorExe) then
  begin
    if not Exec(DoctorExe, 'doctor --quiet', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      { Could not even launch the doctor — warn but continue (non-fatal). }
      Log('Provisioning doctor failed to launch; continuing (CPU-only fallback available).')
    else if ResultCode <> 0 then
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
  if Result <> '' then
    Exit;

  { Destructive steps last, after every check that can still cancel setup:
    a cancel after the old files were deleted would leave no working backend. }
  if not StopExistingService then
  begin
    Result := 'The {#MyServiceName} service did not stop within 30 seconds, so its files cannot be replaced.' + #13#10 +
              'Stop it in services.msc (or reboot), then run setup again.';
    Exit;
  end;
  RemoveOldService;
  StopControlApps;
  FailedPath := RemoveOldProgramFiles;
  if FailedPath <> '' then
  begin
    Result := 'Could not remove the previous version''s file:' + #13#10 + FailedPath + #13#10#13#10 +
              'Close any program using it (or reboot), then run setup again. Your settings, token and models are unchanged.';
    Exit;
  end;
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

{ ---- Firewall: delete any rule with our name first, so an upgrade does not
  leave one rule per install. The rule allows run_server.exe rather than one
  port, so a port changed later in the user's settings needs no new rule.
  Private and domain profiles only: a backend on a public network should not
  be reachable from it. ---- }
procedure AddFirewallRule;
var
  ResultCode: Integer;
begin
  Exec('netsh.exe', 'advfirewall firewall delete rule name="{#MyFirewallRule}"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if not Exec('netsh.exe', 'advfirewall firewall add rule name="{#MyFirewallRule}" dir=in action=allow protocol=TCP program="'
      + ExpandConstant('{app}\run_server.exe') + '" profile=private,domain', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('netsh failed to launch')
  else
    Log(Format('netsh add rule exited %d', [ResultCode]));
end;

{ VC++ runtime, then the firewall rule. The driver pre-check ran earlier
  (PrepareToInstall). }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    InstallVCRedist;
    AddFirewallRule;
  end;
end;

{ ---- Finish page: where the backend runs and where its key is ---- }
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
      'The backend runs as you and starts when you sign in. Start, stop and restart it from the tray icon or the control window; neither asks for administrator approval.' + #13#10#13#10 +
      'Open the control window to copy the backend URL and API key into SubSmelt -> Settings -> Speech to Text.';
end;
