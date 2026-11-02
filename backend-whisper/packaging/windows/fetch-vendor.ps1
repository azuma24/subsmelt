<#
.SYNOPSIS
  Fetch the third-party binaries the Windows build needs into packaging\windows\vendor\.

.DESCRIPTION
  The build (PyInstaller spec + Inno Setup installer) expects three vendored
  binaries that are deliberately NOT committed to the repo (large, redistributable,
  and licensed separately):

    vendor\ffmpeg.exe         static ffmpeg from a pinned, SHA-256 verified
                              BtbN release build, bundled beside run_server.exe;
                              app/audio.py uses it via SUBSMELT_FFMPEG.
    vendor\vc_redist.x64.exe  Microsoft VC++ runtime, silently installed by the
                              installer ([Files]/[Run] in installer.iss).
    vendor\nemo-speech\bin\   NeMo-Speech.cpp CUDA runtime (nemo-speech.exe and
                              its DLLs) for the Nemotron ASR engine, bundled as
                              nemo-speech\bin\ beside run_server.exe. The
                              download is pinned and SHA-256 verified.

  CI runs this on a windows-latest runner before building; local Windows builders
  can run it once to populate vendor\. It is idempotent: a vendored item is kept
  when its version marker (vendor\<name>.version) matches the pin here, and
  re-fetched when the pin changes or -Force is given. WINDOWS-ONLY (downloads
  win64 binaries).

.PARAMETER Force
  Re-download even if the target file already exists.

.EXAMPLE
  pwsh packaging\windows\fetch-vendor.ps1
#>
[CmdletBinding()]
param(
    [switch]$Force
)

# ffmpeg: a dated BtbN release build of the 8.1 branch, not the moving "latest".
# To bump: `gh release list --repo BtbN/FFmpeg-Builds`, pick a win64-gpl (static,
# non-shared) zip from `gh release view <tag> --repo BtbN/FFmpeg-Builds --json
# assets`, and copy its sha256 digest here.
$FfmpegRelease = "autobuild-2026-10-24-13-02"
$FfmpegZip = "ffmpeg-n8.1.3-24-g92611900bb-win64-gpl-8.1.zip"
$FfmpegSha256 = "0b1a903367bfbe906125aad78069e3b9dfecac74ea76db05ada2e667c80ac2c9"

$NemoSpeechVersion = "0.1.0"
$NemoSpeechSha256 = "ba024204e76ca2fa4eefa8787506c3c49e418147f627f60cf9206a582b60089c"

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # huge speedup for Invoke-WebRequest on CI

$VendorDir = Join-Path $PSScriptRoot "vendor"
New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null

$FfmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$FfmpegRelease/$FfmpegZip"
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

# The marker sits at the vendor root (vendor\ffmpeg.exe.version), never inside
# a folder the spec copies into the bundle.
function Get-VersionMarker {
    param([string]$Name)
    return Join-Path $VendorDir ((Split-Path $Name -Leaf) + ".version")
}

function Get-Vendor {
    param([string]$Name, [string]$Url, [string]$Version, [scriptblock]$PostProcess)

    $target = Join-Path $VendorDir $Name
    $marker = Get-VersionMarker -Name $Name
    $cachedVersion = if (Test-Path $marker) { (Get-Content -Raw $marker).Trim() } else { "" }
    if ((Test-Path $target) -and -not $Force -and $cachedVersion -eq $Version) {
        Write-Host "[fetch-vendor] $Name $Version already present - skipping (use -Force to refresh)."
        return
    }
    if ((Test-Path $target) -and $cachedVersion -ne $Version) {
        Write-Host "[fetch-vendor] $Name is '$cachedVersion', pin is '$Version' - refetching."
    }
    Write-Host "[fetch-vendor] downloading $Name from $Url"
    & $PostProcess $Url $target
    if (-not (Test-Path $target)) {
        throw "[fetch-vendor] failed to produce $target"
    }
    Set-Content -Path $marker -Value $Version -NoNewline
    $sizeMb = [math]::Round((Get-Item $target).Length / 1MB, 1)
    Write-Host "[fetch-vendor] $Name ready (${sizeMb} MB)"
}

Get-Vendor -Name "vc_redist.x64.exe" -Url $VcRedistUrl -Version "latest" -PostProcess {
    param($url, $target)
    Invoke-WebRequest -Uri $url -OutFile $target
}

Get-Vendor -Name "ffmpeg.exe" -Url $FfmpegUrl -Version $FfmpegZip -PostProcess {
    param($url, $target)
    $tmpZip = Join-Path $env:TEMP $FfmpegZip
    $tmpExtract = Join-Path $env:TEMP "ffmpeg-extract"
    Invoke-WebRequest -Uri $url -OutFile $tmpZip
    Assert-Sha256 -Path $tmpZip -Expected $FfmpegSha256
    if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
    # Zip lays out as ffmpeg-*/bin/ffmpeg.exe - find it regardless of the dir name.
    $exe = Get-ChildItem -Path $tmpExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if (-not $exe) { throw "ffmpeg.exe not found inside $url archive" }
    Copy-Item -Path $exe.FullName -Destination $target -Force
    Remove-Item -Force $tmpZip
    Remove-Item -Recurse -Force $tmpExtract
}

Get-Vendor -Name "nemo-speech\bin\nemo-speech.exe" -Url $NemoSpeechUrl -Version $NemoSpeechVersion -PostProcess {
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
