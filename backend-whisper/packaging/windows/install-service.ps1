<#
.SYNOPSIS
    Register the SubSmelt Whisper backend (run_server.exe --service) as an
    auto-start Windows Service with crash recovery, and write its settings to
    config.json.

.DESCRIPTION
    WINDOWS-ONLY. Run from an elevated (Administrator) PowerShell. Uses the
    built-in service cmdlets and `sc.exe failure` so there is no NSSM dependency.
    run_server.exe --service talks to the Service Control Manager itself
    (winservice.py), which `sc.exe` requires of a service binary.

    Settings go to <DataDir>\config.json, which run_server.exe reads on every
    start. The previous installer stored them as machine environment variables,
    which a service does not see until the next reboot and which override
    config.json once they do; those variables are removed here.

    <DataDir> is locked to SYSTEM and Administrators (Users read-only).
    config.json is writable by SYSTEM and Administrators and readable by Users,
    so the unelevated control window can show the service's settings and token;
    any local account can therefore read the token. The media folder stays
    writable by Users: it is where files to transcribe are dropped.

.PARAMETER ExePath
    Full path to run_server.exe (the PyInstaller onedir output). Defaults to the
    exe sitting next to this script's install location.

.PARAMETER ServiceName
    Windows Service name. Default: SubSmeltWhisper.

.PARAMETER Port
    TCP port the server binds (config key "port").

.PARAMETER ModelDir
    Model cache directory (config key "model_dir", exported as HF_HOME).

.PARAMETER MediaRoot
    Folder the backend may read media from (config key "media_root").

.PARAMETER DataDir
    Folder holding config.json and logs\. Default: C:\ProgramData\SubSmelt.

.PARAMETER Token
    Shared-secret bearer token. An existing token in config.json is kept when
    this is blank, so an upgrade never invalidates the key SubSmelt already uses.

.PARAMETER GenerateToken
    Mint a strong token when config.json has none and -Token is blank. Minted by
    run_server.exe --generate-token, the same way the control window does it.

.PARAMETER Version
    Version string stored as config key "version" so /health reports the shipped
    version instead of the source default.

.PARAMETER InfoFile
    When set, the backend URL, token and paths are written to this file (readable by
    administrators only) instead of the token being printed. The installer shows
    the file on its finish page.

.EXAMPLE
    .\install-service.ps1 -Port 8001 -GenerateToken
#>
[CmdletBinding()]
param(
    [string]$ExePath = (Join-Path $PSScriptRoot "run_server.exe"),
    [string]$ServiceName = "SubSmeltWhisper",
    [int]$Port = 8001,
    [string]$ModelDir = "C:\ProgramData\SubSmelt\models",
    [string]$MediaRoot = "C:\ProgramData\SubSmelt\media",
    [string]$DataDir = "C:\ProgramData\SubSmelt",
    [string]$Token = "",
    [switch]$GenerateToken,
    [string]$Version = "",
    [string]$InfoFile = "",
    [string]$DisplayName = "SubSmelt Whisper Backend"
)

$ErrorActionPreference = "Stop"

# Well-known SIDs, so the ACLs work on a localized Windows too.
$SystemSid = "*S-1-5-18"
$AdministratorsSid = "*S-1-5-32-544"
$UsersSid = "*S-1-5-32-545"

# Machine-scope variables the previous installer set. They override config.json
# in run_server.exe, so they have to go for config.json to mean anything.
$LegacyMachineVars = @(
    "SUBSMELT_WHISPER_PORT",
    "SUBSMELT_WHISPER_MODEL_DIR",
    "SUBSMELT_WHISPER_MEDIA_ROOT",
    "SUBSMELT_WHISPER_TOKEN",
    "SUBSMELT_WHISPER_VERSION",
    "SUBSMELT_FFMPEG",
    "SUBSMELT_NEMO_SPEECH"
)

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "This script must be run from an elevated (Administrator) PowerShell."
    }
}

function Invoke-Icacls {
    param([string[]]$Arguments)
    & icacls.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

# SYSTEM and Administrators only: the file holds the token.
function Protect-SecretFile {
    param([string]$Path)
    Invoke-Icacls @($Path, "/inheritance:r", "/grant:r", "${SystemSid}:F", "${AdministratorsSid}:F")
}

# Only administrators may change the service's settings, but Users may read
# them: the control window runs unelevated and has to show the real port and
# token. Readable means every local account can see the token.
function Protect-ConfigFile {
    param([string]$Path)
    Invoke-Icacls @($Path, "/inheritance:r", "/grant:r", "${SystemSid}:F", "${AdministratorsSid}:F", "${UsersSid}:R")
}

function Read-Config {
    param([string]$Path)
    $config = [ordered]@{}
    if (-not (Test-Path $Path)) { return $config }
    try {
        $loaded = Get-Content -Raw -Path $Path | ConvertFrom-Json
    } catch {
        Write-Warning "Could not parse ${Path}: $_. Starting from an empty config."
        return $config
    }
    foreach ($property in $loaded.PSObject.Properties) {
        $config[$property.Name] = $property.Value
    }
    return $config
}

# Atomic and BOM-free: run_server.exe may be reading the file, and Python's
# json.load rejects the BOM that Set-Content -Encoding UTF8 writes.
function Write-Config {
    param([string]$Path, $Config)
    $json = ConvertTo-Json -InputObject $Config -Depth 4
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
    Move-Item -Force -Path $tmp -Destination $Path
}

function New-MintedToken {
    param([string]$Exe)
    $generated = & $Exe --generate-token |
        Select-String -Pattern '^\s{4}(\S+)$' |
        ForEach-Object { $_.Matches[0].Groups[1].Value } |
        Select-Object -First 1
    if (-not $generated) { throw "Could not generate a token via $Exe --generate-token." }
    return $generated
}

function Test-UnderDirectory {
    param([string]$Path, [string]$Parent)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $root = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    return $full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

Assert-Admin

if (-not (Test-Path $ExePath)) {
    throw "run_server.exe not found at '$ExePath'. Build the onedir bundle first (see README)."
}

$ConfigPath = Join-Path $DataDir "config.json"
$LogsDir = Join-Path $DataDir "logs"
$LogFile = Join-Path $LogsDir "whisper-server.log"
$BundleDir = Split-Path $ExePath -Parent

foreach ($dir in @($DataDir, $LogsDir, $ModelDir, $MediaRoot)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# --- config.json ---------------------------------------------------------------
Write-Host "Writing $ConfigPath..."
$config = Read-Config -Path $ConfigPath

$existingToken = [string]$config["token"]
$minted = $false
if ($Token -ne "") {
    $config["token"] = $Token
} elseif ($existingToken.Trim() -ne "") {
    Write-Host "Keeping the existing token."
    $Token = $existingToken.Trim()
} elseif ($GenerateToken) {
    $Token = New-MintedToken -Exe $ExePath
    $config["token"] = $Token
    $minted = $true
}
if ($Token -eq "") {
    Write-Warning "No token set: the backend binds 0.0.0.0 and will accept requests from any host on this network."
    Write-Warning "Re-run with -GenerateToken to have one created for you."
}

$config["port"] = $Port
$config["model_dir"] = $ModelDir
$config["media_root"] = $MediaRoot
$config["log_file"] = $LogFile
if ($Version -ne "") { $config["version"] = $Version }

# Bundled tools sit beside run_server.exe. A key for a tool that is not in this
# build would point the service at a file from an older install, so drop it.
$bundled = @{
    "ffmpeg" = (Join-Path $BundleDir "ffmpeg.exe")
    "nemo_speech" = (Join-Path $BundleDir "nemo-speech\bin\nemo-speech.exe")
}
foreach ($key in $bundled.Keys) {
    if (Test-Path $bundled[$key]) { $config[$key] = $bundled[$key] } else { $config.Remove($key) }
}

Write-Config -Path $ConfigPath -Config $config

# --- Permissions ---------------------------------------------------------------
Write-Host "Setting permissions on $DataDir..."
Invoke-Icacls @($DataDir, "/inheritance:r", "/grant:r",
    "${SystemSid}:(OI)(CI)F", "${AdministratorsSid}:(OI)(CI)F", "${UsersSid}:(OI)(CI)RX")
if (Test-UnderDirectory -Path $MediaRoot -Parent $DataDir) {
    Invoke-Icacls @($MediaRoot, "/grant:r", "${UsersSid}:(OI)(CI)M")
}
Protect-ConfigFile -Path $ConfigPath

# --- Legacy machine environment variables ---------------------------------------
foreach ($name in $LegacyMachineVars) {
    if ($null -ne [Environment]::GetEnvironmentVariable($name, "Machine")) {
        Write-Host "Removing machine environment variable $name (config.json replaces it)."
        [Environment]::SetEnvironmentVariable($name, $null, "Machine")
    }
}

# --- Service -------------------------------------------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Existing service '$ServiceName' found - stopping and removing..."
    if ($existing.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        $existing.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    }
    sc.exe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe delete $ServiceName failed with exit code $LASTEXITCODE" }
    Start-Sleep -Seconds 2
}

Write-Host "Creating service '$ServiceName'..."
# New-Service hands the string to the CreateService API as-is, so the quoted
# exe path plus the --service flag survive (sc.exe's quoting through PowerShell
# does not).
New-Service -Name $ServiceName -BinaryPathName "`"$ExePath`" --service" `
    -DisplayName $DisplayName -StartupType Automatic `
    -Description "SubSmelt remote Whisper transcription backend (CUDA)." | Out-Null

# Crash recovery: restart after 5s/10s/30s; the failure count resets after a
# day of healthy uptime.
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe failure $ServiceName failed with exit code $LASTEXITCODE" }

Write-Host "Starting service..."
Start-Service -Name $ServiceName

# RUNNING is reported before the model stack loads; /health is the real check.
$healthUrl = "http://127.0.0.1:$Port/health"
$healthy = $false
for ($i = 0; $i -lt 90; $i++) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2 | Out-Null
        $healthy = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
    if ((Get-Service -Name $ServiceName).Status -ne "Running") {
        throw "Service '$ServiceName' stopped during startup. See $LogFile."
    }
}
if (-not $healthy) {
    Write-Warning "Service is running but $healthUrl did not answer within 90 s. Check $LogFile."
}

# --- Report --------------------------------------------------------------------
$backendUrl = "http://$([System.Net.Dns]::GetHostName()):$Port"
if ($InfoFile -ne "") {
    $lines = @(
        "SubSmelt Whisper Backend",
        "",
        "Backend URL:  $backendUrl",
        "Health check: $backendUrl/health"
    )
    if ($Token -ne "") {
        $lines += "Backend token: $Token"
        $lines += ""
        $lines += "Paste the URL and token into SubSmelt -> Settings -> Speech to Text."
    } else {
        $lines += "Backend token: (none - every host on the network can use this backend)"
    }
    $lines += ""
    $lines += "Settings: $ConfigPath (administrators edit, users read)"
    $lines += "Logs:     $LogsDir"
    [System.IO.File]::WriteAllLines($InfoFile, $lines, (New-Object System.Text.UTF8Encoding $false))
    Protect-SecretFile -Path $InfoFile
    Write-Host "Connection details written to $InfoFile."
} elseif ($minted) {
    Write-Host ""
    Write-Host "Backend API key: $Token" -ForegroundColor Green
    Write-Host "Paste it into SubSmelt -> Settings -> Speech to Text -> Backend token."
    Write-Host ""
}

$svc = Get-Service -Name $ServiceName
Write-Host "Service '$ServiceName' is now: $($svc.Status). Listening on port $Port."
Write-Host "Verify with: Invoke-WebRequest $healthUrl"
