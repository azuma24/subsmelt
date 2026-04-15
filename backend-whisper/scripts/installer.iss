; Inno Setup script for subsmelt-whisper.
;
; Build via build-windows.ps1 which runs PyInstaller first, then calls iscc.
; Expects ISCC.exe to be on PATH.
;
; Produces dist\SubsmeltWhisperSetup-<Version>.exe
;
; Compile manually:
;     iscc /DVersion=0.1.0 scripts\installer.iss

#ifndef Version
  #define Version "0.1.0"
#endif

[Setup]
AppName=Subsmelt Whisper
AppVersion={#Version}
AppPublisher=subsmelt
AppPublisherURL=https://github.com/azuma24/subsmelt
DefaultDirName={autopf}\SubsmeltWhisper
DefaultGroupName=Subsmelt Whisper
OutputBaseFilename=SubsmeltWhisperSetup-{#Version}
OutputDir=..\dist
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64
DisableProgramGroupPage=yes
DisableDirPage=auto
WizardStyle=modern
SetupLogging=yes

[Files]
; The PyInstaller one-folder build goes into {app}\.
Source: "..\dist\subsmelt-whisper\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; nssm.exe must be placed in scripts\nssm.exe before building.
Source: "nssm.exe"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Dirs]
Name: "{commonappdata}\SubsmeltWhisper"; Permissions: users-modify

[Icons]
Name: "{group}\Start Subsmelt Whisper"; Filename: "{app}\subsmelt-whisper.exe"; Parameters: "serve"
Name: "{group}\Show API Key"; Filename: "notepad.exe"; Parameters: """{commonappdata}\SubsmeltWhisper\config.ini"""
Name: "{group}\Open Config Folder"; Filename: "explorer.exe"; Parameters: """{commonappdata}\SubsmeltWhisper"""
Name: "{group}\Uninstall"; Filename: "{uninstallexe}"

[Tasks]
Name: "longpaths"; Description: "Enable Windows long-path support (recommended for model caches)"; GroupDescription: "System tweaks:"; Flags: checkedonce
Name: "runservice"; Description: "Install and start as a Windows Service (auto-start on boot)"; GroupDescription: "Service:"; Flags: checkedonce

[Registry]
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\FileSystem"; ValueType: dword; ValueName: "LongPathsEnabled"; ValueData: 1; Tasks: longpaths

[Run]
; Run the binary once to trigger first-run API key generation so the installer
; can display it on its final page.
Filename: "{app}\subsmelt-whisper.exe"; Parameters: "show-config"; Flags: runhidden waituntilterminated

; Install the Windows service via nssm.
Filename: "{app}\nssm.exe"; Parameters: "install SubsmeltWhisper ""{app}\subsmelt-whisper.exe"" serve"; Tasks: runservice; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set SubsmeltWhisper AppDirectory ""{app}"""; Tasks: runservice; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set SubsmeltWhisper AppStdout ""{commonappdata}\SubsmeltWhisper\service.log"""; Tasks: runservice; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set SubsmeltWhisper AppStderr ""{commonappdata}\SubsmeltWhisper\service.log"""; Tasks: runservice; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set SubsmeltWhisper Start SERVICE_AUTO_START"; Tasks: runservice; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "start SubsmeltWhisper"; Tasks: runservice; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{app}\nssm.exe"; Parameters: "stop SubsmeltWhisper"; Flags: runhidden; RunOnceId: "stop-svc"
Filename: "{app}\nssm.exe"; Parameters: "remove SubsmeltWhisper confirm"; Flags: runhidden; RunOnceId: "remove-svc"

[Code]
var
  ApiKeyPage: TOutputMsgMemoWizardPage;

function ReadApiKey(): String;
var
  Content: AnsiString;
  Lines: TArrayOfString;
  I: Integer;
  Line, Key: String;
begin
  Result := '';
  if LoadStringFromFile(ExpandConstant('{commonappdata}\SubsmeltWhisper\config.ini'), Content) then
  begin
    Lines := TArrayOfString(Content);
    // Fall back: split manually.
  end;
  // Simpler: read line by line.
  if FileExists(ExpandConstant('{commonappdata}\SubsmeltWhisper\config.ini')) then
  begin
    LoadStringsFromFile(ExpandConstant('{commonappdata}\SubsmeltWhisper\config.ini'), Lines);
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      Line := Trim(Lines[I]);
      if Pos('api_key', Line) = 1 then
      begin
        Key := Trim(Copy(Line, Pos('=', Line) + 1, Length(Line)));
        Result := Key;
        Exit;
      end;
    end;
  end;
end;

procedure InitializeWizard();
begin
  ApiKeyPage := CreateOutputMsgMemoPage(
    wpInfoAfter,
    'API Key',
    'Your generated API key',
    'Paste this into Subsmelt → Settings → Transcription → API key. ' +
      'You can find it again later at %ProgramData%\SubsmeltWhisper\config.ini.',
    ''
  );
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Key: String;
begin
  if CurStep = ssPostInstall then
  begin
    Key := ReadApiKey();
    if Key <> '' then
      ApiKeyPage.RichEditViewer.Text := Key
    else
      ApiKeyPage.RichEditViewer.Text :=
        'API key not found — run "subsmelt-whisper serve" once, then check config.ini.';
  end;
end;
