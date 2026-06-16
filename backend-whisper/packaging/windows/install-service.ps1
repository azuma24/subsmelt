<#
.SYNOPSIS
    Register the SubSmelt Whisper backend (run_server.exe) as an auto-start
    Windows Service with crash recovery. Plan Phase 3 ("Service").

.DESCRIPTION
    WINDOWS-ONLY. Cannot be run/tested on macOS/Linux. Run from an elevated
    (Administrator) PowerShell. Uses the built-in `sc.exe` so there is no NSSM
    dependency; run_server.exe is a console app that uvicorn keeps in the
    foreground, which `sc.exe` supervises directly.

    Crash recovery is configured via `sc.exe failure` so the service restarts
    automatically (plan: "recovery/restart on crash").

.PARAMETER ExePath
    Full path to run_server.exe (the PyInstaller onedir output). Defaults to the
    exe sitting next to this script's install location.

.PARAMETER ServiceName
    Windows Service name. Default: SubSmeltWhisper.

.PARAMETER Port
    TCP port the server binds. Exported as SUBSMELT_WHISPER_PORT for the service.

.PARAMETER ModelDir
    Model cache directory (HF_HOME). Models are downloaded here by the manager.

.PARAMETER Token
    Optional shared-secret bearer token (Phase 1 auth). When set, the server
    binds 0.0.0.0; otherwise localhost only.

.EXAMPLE
    .\install-service.ps1 -Port 8001 -ModelDir "C:\ProgramData\SubSmelt\models"
#>
[CmdletBinding()]
param(
    [string]$ExePath = (Join-Path $PSScriptRoot "run_server.exe"),
    [string]$ServiceName = "SubSmeltWhisper",
    [int]$Port = 8001,
    [string]$ModelDir = "C:\ProgramData\SubSmelt\models",
    [string]$MediaRoot = "C:\ProgramData\SubSmelt\media",
    [string]$Token = "",
    [string]$DisplayName = "SubSmelt Whisper Backend"
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "This script must be run from an elevated (Administrator) PowerShell."
    }
}

Assert-Admin

if (-not (Test-Path $ExePath)) {
    throw "run_server.exe not found at '$ExePath'. Build the onedir bundle first (see README)."
}

# --- Persist configuration as MACHINE-scope environment variables -----------
# The service runs as LocalSystem with no user profile, so config must live in
# machine-scope env so run_server.py's load_config() can read it. The launcher
# reads SUBSMELT_WHISPER_* (see run_server.py) and re-exports MEDIA_ROOT/HF_HOME.
Write-Host "Configuring machine environment variables..."
[Environment]::SetEnvironmentVariable("SUBSMELT_WHISPER_PORT", "$Port", "Machine")
[Environment]::SetEnvironmentVariable("SUBSMELT_WHISPER_MODEL_DIR", $ModelDir, "Machine")
[Environment]::SetEnvironmentVariable("SUBSMELT_WHISPER_MEDIA_ROOT", $MediaRoot, "Machine")
if ($Token -ne "") {
    [Environment]::SetEnvironmentVariable("SUBSMELT_WHISPER_TOKEN", $Token, "Machine")
}
# Point ffmpeg at the bundled exe (sits next to run_server.exe in the onedir output).
$ffmpeg = Join-Path (Split-Path $ExePath -Parent) "ffmpeg.exe"
if (Test-Path $ffmpeg) {
    [Environment]::SetEnvironmentVariable("SUBSMELT_FFMPEG", $ffmpeg, "Machine")
}

# Ensure model + media dirs exist.
New-Item -ItemType Directory -Force -Path $ModelDir  | Out-Null
New-Item -ItemType Directory -Force -Path $MediaRoot | Out-Null

# --- Remove any prior instance so re-install is idempotent ------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Existing service '$ServiceName' found — stopping and removing..."
    if ($existing.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

# --- Create the service (auto-start) ----------------------------------------
# binPath must be quoted; sc.exe requires a space after '=' .
Write-Host "Creating service '$ServiceName'..."
$binPath = "`"$ExePath`""
sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "$DisplayName" | Out-Null
sc.exe description $ServiceName "SubSmelt remote Whisper transcription backend (CUDA)." | Out-Null

# --- Crash recovery: restart on the 1st/2nd/3rd failure ---------------------
# reset= 86400 -> failure count resets after a day of healthy uptime.
# actions are restart/restart/restart with 5s/10s/30s delays (ms).
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

Write-Host "Starting service..."
Start-Service -Name $ServiceName

$svc = Get-Service -Name $ServiceName
Write-Host "Service '$ServiceName' is now: $($svc.Status). Listening on port $Port."
Write-Host "Verify with: Invoke-WebRequest http://127.0.0.1:$Port/health"
