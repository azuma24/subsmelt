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
;   * Installs the --onedir output (dist\whisper-server\) into Program Files.
;   * Bundles + silently installs the VC++ redistributable.
;   * Runs a driver-version / hardware PRE-CHECK gate (Phase 3a provisioning).
;   * Registers the Windows Service (install-service.ps1).
;   * Adds a Windows Firewall rule for the chosen port.
;   * Provides a clean uninstaller (uninstall-service.ps1 + firewall removal).
;
; Models are NOT bundled (plan Phase 3/3a). First run uses the model manager.
; =============================================================================

#define MyAppName "SubSmelt Whisper Backend"
#define MyAppVersion "0.4.2"
#define MyAppPublisher "SubSmelt"
#define MyServiceName "SubSmeltWhisper"
#define MyDefaultPort "8001"

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
Name: "{group}\Open Whisper Config";    Filename: "notepad.exe"; Parameters: """{commonappdata}\SubSmelt\config.json"""
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; ---------------------------------------------------------------------------
; Order matters: VC++ redist -> service registration -> firewall rule.
; The driver pre-check runs earlier in code (PrepareToInstall, see below).
; ---------------------------------------------------------------------------

; 1) VC++ redistributable, silent. /norestart so we don't reboot mid-install.
Filename: "{tmp}\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; \
    StatusMsg: "Installing Visual C++ runtime..."; Check: VCRedistBundled; Flags: waituntilterminated

; 2) Register the Windows Service via the bundled PowerShell script.
;    Port comes from the wizard page (default 8001). ExecutionPolicy Bypass so an
;    unsigned script runs; the script itself asserts admin.
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-service.ps1"" -ExePath ""{app}\run_server.exe"" -ServiceName ""{#MyServiceName}"" -Port {code:GetPort} -ModelDir ""{commonappdata}\SubSmelt\models"" -MediaRoot ""{commonappdata}\SubSmelt\media"""; \
    StatusMsg: "Registering Windows Service..."; Flags: runhidden waituntilterminated

; 3) Windows Firewall rule for the inbound port (only meaningful for remote use).
Filename: "netsh.exe"; \
    Parameters: "advfirewall firewall add rule name=""SubSmelt Whisper Backend"" dir=in action=allow protocol=TCP localport={code:GetPort}"; \
    StatusMsg: "Adding Windows Firewall rule..."; Flags: runhidden waituntilterminated

[UninstallRun]
; Remove the service first (before files are deleted).
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"" -ServiceName ""{#MyServiceName}"""; \
    RunOnceId: "RemoveService"; Flags: runhidden waituntilterminated
; Remove the firewall rule.
Filename: "netsh.exe"; \
    Parameters: "advfirewall firewall delete rule name=""SubSmelt Whisper Backend"""; \
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

{ ---- True if the bundled VC++ redist was dropped in at build time ---- }
function VCRedistBundled: Boolean;
begin
  { ExpandConstant('{tmp}\vc_redist.x64.exe') only exists if the [Files] entry
    copied it; the entry itself is gated on this same check, so we test the
    source path the compiler embedded. We approximate by always returning True
    and letting the [Files] 'Check' decide; if the source file is missing at
    COMPILE time, ISCC errors — which is the desired "drop it in" enforcement. }
  Result := True;
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

{ Ensure the shared config/data dirs exist post-install so the service + model
  manager have a known location. }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    ForceDirectories(ExpandConstant('{commonappdata}\SubSmelt'));
    ForceDirectories(ExpandConstant('{commonappdata}\SubSmelt\models'));
    ForceDirectories(ExpandConstant('{commonappdata}\SubSmelt\media'));
    ForceDirectories(ExpandConstant('{commonappdata}\SubSmelt\logs'));
  end;
end;
