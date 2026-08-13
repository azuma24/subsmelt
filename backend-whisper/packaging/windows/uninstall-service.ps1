<#
.SYNOPSIS
    Stop and remove the SubSmelt Whisper Windows Service. Plan Phase 3.

.DESCRIPTION
    WINDOWS-ONLY. Run from an elevated (Administrator) PowerShell. Mirrors
    install-service.ps1: stops the service, deletes it via sc.exe, and optionally
    clears the machine-scope environment variables it set.

.PARAMETER ServiceName
    Windows Service name. Default: SubSmeltWhisper.

.PARAMETER KeepConfig
    When set, leaves the SUBSMELT_WHISPER_* machine env vars in place (useful for
    upgrade-in-place). By default they are removed.

.EXAMPLE
    .\uninstall-service.ps1
#>
[CmdletBinding()]
param(
    [string]$ServiceName = "SubSmeltWhisper",
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
        Start-Sleep -Seconds 2
    }
    Write-Host "Deleting service '$ServiceName'..."
    sc.exe delete $ServiceName | Out-Null
} else {
    Write-Host "Service '$ServiceName' not installed — nothing to remove."
}

if (-not $KeepConfig) {
    Write-Host "Clearing machine environment variables..."
    foreach ($name in @(
        "SUBSMELT_WHISPER_PORT",
        "SUBSMELT_WHISPER_MODEL_DIR",
        "SUBSMELT_WHISPER_MEDIA_ROOT",
        "SUBSMELT_WHISPER_TOKEN",
        "SUBSMELT_FFMPEG"
    )) {
        [Environment]::SetEnvironmentVariable($name, $null, "Machine")
    }
}

Write-Host "Done."
