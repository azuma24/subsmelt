<#
.SYNOPSIS
  Fetch the third-party binaries the Windows build needs into packaging\windows\vendor\.

.DESCRIPTION
  The build (PyInstaller spec + Inno Setup installer) expects three vendored
  binaries that are deliberately NOT committed to the repo (large, redistributable,
  and licensed separately):

    vendor\ffmpeg.exe         static ffmpeg, bundled beside run_server.exe;
                              app/audio.py uses it via SUBSMELT_FFMPEG.
    vendor\vc_redist.x64.exe  Microsoft VC++ runtime, silently installed by the
                              installer ([Files]/[Run] in installer.iss).
    vendor\nemo-speech\bin\   NeMo-Speech.cpp CUDA runtime (nemo-speech.exe and
                              its DLLs) for the Nemotron ASR engine, bundled as
                              nemo-speech\bin\ beside run_server.exe. The
                              download is pinned and SHA-256 verified.

  CI runs this on a windows-latest runner before building; local Windows builders
  can run it once to populate vendor\. It is idempotent — existing files are kept
  unless -Force is given. WINDOWS-ONLY (downloads win64 binaries).

.PARAMETER Force
  Re-download even if the target file already exists.

.EXAMPLE
  pwsh packaging\windows\fetch-vendor.ps1
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$NemoSpeechVersion = "0.1.0"
$NemoSpeechSha256 = "ba024204e76ca2fa4eefa8787506c3c49e418147f627f60cf9206a582b60089c"

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # huge speedup for Invoke-WebRequest on CI

$VendorDir = Join-Path $PSScriptRoot "vendor"
New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null

# ffmpeg: BtbN nightly GPL win64 build is a stable, widely-used source of a
# self-contained static ffmpeg.exe. We extract only bin\ffmpeg.exe.
$FfmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
# VC++ redistributable: Microsoft's permalink to the latest x64 runtime.
$VcRedistUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
$NemoSpeechZip = "nemo-speech-$NemoSpeechVersion-windows-x86_64-cuda.zip"
$NemoSpeechUrl = "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v$NemoSpeechVersion/$NemoSpeechZip"

function Assert-Sha256 {
    param([string]$Path, [string]$Expected)

    $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash
    if ($actual -ne $Expected) {
        throw "[fetch-vendor] SHA-256 mismatch for ${Path}: expected $Expected, got $actual"
    }
}

# The release zip is flat (bin\, include\, lib\); only bin\ is needed at runtime.
function Expand-NemoSpeechBin {
    param([string]$Zip, [string]$BinDir, [string]$ScratchDir)

    if (Test-Path $ScratchDir) { Remove-Item -Recurse -Force $ScratchDir }
    Expand-Archive -Path $Zip -DestinationPath $ScratchDir -Force
    $exe = Join-Path $ScratchDir "bin\nemo-speech.exe"
    if (-not (Test-Path $exe)) { throw "bin\nemo-speech.exe not found inside $Zip" }
    if (Test-Path $BinDir) { Remove-Item -Recurse -Force $BinDir }
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Copy-Item -Path (Join-Path $ScratchDir "bin\*") -Destination $BinDir -Recurse -Force
    Remove-Item -Recurse -Force $ScratchDir
}

function Get-Vendor {
    param([string]$Name, [string]$Url, [scriptblock]$PostProcess)

    $target = Join-Path $VendorDir $Name
    if ((Test-Path $target) -and -not $Force) {
        Write-Host "[fetch-vendor] $Name already present — skipping (use -Force to refresh)."
        return
    }
    Write-Host "[fetch-vendor] downloading $Name from $Url"
    & $PostProcess $Url $target
    if (-not (Test-Path $target)) {
        throw "[fetch-vendor] failed to produce $target"
    }
    $sizeMb = [math]::Round((Get-Item $target).Length / 1MB, 1)
    Write-Host "[fetch-vendor] $Name ready (${sizeMb} MB)"
}

Get-Vendor -Name "vc_redist.x64.exe" -Url $VcRedistUrl -PostProcess {
    param($url, $target)
    Invoke-WebRequest -Uri $url -OutFile $target
}

Get-Vendor -Name "ffmpeg.exe" -Url $FfmpegUrl -PostProcess {
    param($url, $target)
    $tmpZip = Join-Path $env:TEMP "ffmpeg-win64-gpl.zip"
    $tmpExtract = Join-Path $env:TEMP "ffmpeg-extract"
    Invoke-WebRequest -Uri $url -OutFile $tmpZip
    if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
    # Zip lays out as ffmpeg-*/bin/ffmpeg.exe — find it regardless of the dir name.
    $exe = Get-ChildItem -Path $tmpExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if (-not $exe) { throw "ffmpeg.exe not found inside $url archive" }
    Copy-Item -Path $exe.FullName -Destination $target -Force
    Remove-Item -Force $tmpZip
    Remove-Item -Recurse -Force $tmpExtract
}

Get-Vendor -Name "nemo-speech\bin\nemo-speech.exe" -Url $NemoSpeechUrl -PostProcess {
    param($url, $target)
    $tmpZip = Join-Path $env:TEMP $NemoSpeechZip
    Invoke-WebRequest -Uri $url -OutFile $tmpZip
    Assert-Sha256 -Path $tmpZip -Expected $NemoSpeechSha256
    Expand-NemoSpeechBin -Zip $tmpZip -BinDir (Split-Path $target -Parent) `
        -ScratchDir (Join-Path $env:TEMP "nemo-speech-extract")
    Remove-Item -Force $tmpZip
}

Write-Host "[fetch-vendor] vendor dir contents:"
Get-ChildItem $VendorDir | Format-Table Name, Length -AutoSize
