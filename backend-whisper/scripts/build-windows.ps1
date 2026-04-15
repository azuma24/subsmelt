<#
.SYNOPSIS
    Build the subsmelt-whisper Windows binary + Inno Setup installer.
.DESCRIPTION
    Creates a fresh venv, installs requirements, runs PyInstaller with the
    bundled spec, then (if `iscc` is on PATH) compiles the Inno Setup installer.
    Produces:
        dist\subsmelt-whisper\            — the one-folder PyInstaller output
        dist\SubsmeltWhisperSetup-*.exe   — the installer (if Inno Setup present)
.NOTES
    Run from backend-whisper\ in an Administrator PowerShell:
        .\scripts\build-windows.ps1
#>
[CmdletBinding()]
param(
    [string]$Version   = "0.1.0",
    [string]$FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path .\.venv)) {
    python -m venv .venv
}
.\.venv\Scripts\pip install --upgrade pip setuptools wheel
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\pip install pyinstaller

# Stage ffmpeg.exe under bin\ for the PyInstaller spec to pick up.
if (-not (Test-Path .\bin\ffmpeg.exe)) {
    New-Item -ItemType Directory -Force -Path .\bin | Out-Null
    $tmpZip = Join-Path $env:TEMP "ffmpeg.zip"
    Write-Host "Downloading ffmpeg from $FfmpegUrl ..."
    Invoke-WebRequest -Uri $FfmpegUrl -OutFile $tmpZip
    $extractDir = Join-Path $env:TEMP "ffmpeg-extract"
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    Expand-Archive -Path $tmpZip -DestinationPath $extractDir
    $ff = Get-ChildItem -Recurse -Path $extractDir -Filter ffmpeg.exe | Select-Object -First 1
    Copy-Item $ff.FullName .\bin\ffmpeg.exe
}

# Clean previous outputs.
Remove-Item -Recurse -Force .\build, .\dist -ErrorAction SilentlyContinue

.\.venv\Scripts\pyinstaller scripts\backend-whisper.spec --clean --noconfirm

# Inno Setup — optional, just produces the .exe installer if available.
$iscc = Get-Command iscc -ErrorAction SilentlyContinue
if ($iscc) {
    & $iscc.Path /DVersion=$Version scripts\installer.iss
} else {
    Write-Warning "iscc (Inno Setup compiler) not found on PATH. Skipping installer build."
    Write-Warning "The one-folder build under dist\subsmelt-whisper\ is ready to zip + ship."
}

Write-Host "Done. Output under dist\ ."
