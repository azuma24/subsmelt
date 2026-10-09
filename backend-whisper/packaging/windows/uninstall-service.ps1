<#
.SYNOPSIS
    Stop and remove the SubSmelt Whisper Windows Service.

.DESCRIPTION
    WINDOWS-ONLY. Run from an elevated (Administrator) PowerShell. Mirrors
    install-service.ps1: stops the service, deletes it, clears the machine-scope
    environment variables an older installer set, and removes config.json and
    backend-info.txt unless -KeepConfig is given. Models, media and logs are
    never touched.

.PARAMETER ServiceName
    Windows Service name. Default: SubSmeltWhisper.

.PARAMETER DataDir
    Folder holding config.json. Default: C:\ProgramData\SubSmelt.

.PARAMETER KeepConfig
    Leave config.json (and the token in it) in place, for a reinstall.

.EXAMPLE
    .\uninstall-service.ps1
#>
[CmdletBinding()]
param(
    [string]$ServiceName = "SubSmeltWhisper",
    [string]$DataDir = "C:\ProgramData\SubSmelt",
    [switch]$KeepConfig
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

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne "Stopped") {
        Write-Host "Stopping service '$ServiceName'..."
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        $svc.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    }
    Write-Host "Deleting service '$ServiceName'..."
    sc.exe delete $ServiceName | Out-Null
} else {
    Write-Host "Service '$ServiceName' not installed - nothing to remove."
}

# Older installers configured the service through these; they override
# config.json, so a reinstall must not inherit them.
foreach ($name in @(
    "SUBSMELT_WHISPER_PORT",
    "SUBSMELT_WHISPER_MODEL_DIR",
    "SUBSMELT_WHISPER_MEDIA_ROOT",
    "SUBSMELT_WHISPER_TOKEN",
    "SUBSMELT_WHISPER_VERSION",
    "SUBSMELT_FFMPEG",
    "SUBSMELT_NEMO_SPEECH"
)) {
    if ($null -ne [Environment]::GetEnvironmentVariable($name, "Machine")) {
        Write-Host "Clearing machine environment variable $name..."
        [Environment]::SetEnvironmentVariable($name, $null, "Machine")
    }
}

if (-not $KeepConfig) {
    foreach ($file in @("config.json", "backend-info.txt")) {
        $path = Join-Path $DataDir $file
        if (Test-Path $path) {
            Write-Host "Removing $path..."
            Remove-Item -Force -Path $path
        }
    }
}

Write-Host "Done."
