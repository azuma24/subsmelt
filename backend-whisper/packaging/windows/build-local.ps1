<#
.SYNOPSIS
  One-shot local build of the SubSmelt Whisper Windows backend + installer (plan
  Phase 6, run by hand instead of in CI).

.DESCRIPTION
  Copy the whole repo to a Windows machine and double-click build-local.bat (which
  calls this script). It performs the same steps the CI workflow does:

    1. find Python, create/reuse a build virtualenv (.venv-build under backend-whisper\)
    2. pip install requirements.txt + cuDNN/cuBLAS wheels + PyInstaller
    3. fetch-vendor.ps1  -> vendor\ffmpeg.exe + vendor\vc_redist.x64.exe
    4. pyinstaller whisper-server.spec  -> dist\whisper-server\run_server.exe
    5. smoke test: run_server.exe --print-config
    6. (if Inno Setup is installed) ISCC installer.iss -> Output\*.exe

  It NEVER bundles model weights — download them post-install via the model manager.
  Re-runnable: the venv and vendor files are reused unless -Clean / -Force are given.

.PARAMETER Version       Version stamped into the installer (default 0.0.0-local).
.PARAMETER SkipInstaller Build only the onedir bundle; skip the Inno Setup step.
.PARAMETER Run           After building, launch the built server (127.0.0.1:8001).
.PARAMETER Clean         Delete the build venv and dist\ before building.
.PARAMETER ForceVendor   Re-download ffmpeg.exe / vc_redist even if present.

.EXAMPLE
  pwsh packaging\windows\build-local.ps1
.EXAMPLE
  pwsh packaging\windows\build-local.ps1 -Version 0.5.0 -Run
#>
[CmdletBinding()]
param(
    [string]$Version = "0.0.0-local",
    [switch]$SkipInstaller,
    [switch]$Run,
    [switch]$Clean,
    [switch]$ForceVendor
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Info($m) { Write-Host "[build-local] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[build-local] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[build-local] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[build-local] ERROR: $m" -ForegroundColor Red; exit 1 }

# Paths: this script lives at backend-whisper\packaging\windows\.
$WinDir      = $PSScriptRoot
$BackendRoot = (Resolve-Path (Join-Path $WinDir "..\..")).Path
$VenvDir     = Join-Path $BackendRoot ".venv-build"
$VenvPy      = Join-Path $VenvDir "Scripts\python.exe"
$SpecPath    = Join-Path $WinDir "whisper-server.spec"
$DistExe     = Join-Path $BackendRoot "dist\whisper-server\run_server.exe"

Info "backend root: $BackendRoot"
Push-Location $BackendRoot
try {
    # --- 0. clean ---
    if ($Clean) {
        Info "clean: removing .venv-build, build\, dist\"
        foreach ($d in @($VenvDir, (Join-Path $BackendRoot "build"), (Join-Path $BackendRoot "dist"))) {
            if (Test-Path $d) { Remove-Item -Recurse -Force $d }
        }
    }

    # --- 1. python + venv ---
    $sysPy = Get-Command python -ErrorAction SilentlyContinue
    if (-not $sysPy) { $sysPy = Get-Command py -ErrorAction SilentlyContinue }
    if (-not $sysPy) {
        Die "Python not found on PATH. Install Python 3.10-3.12 from https://python.org (check 'Add to PATH')."
    }
    if (-not (Test-Path $VenvPy)) {
        Info "creating build venv at $VenvDir"
        & $sysPy.Source -m venv $VenvDir
        if ($LASTEXITCODE -ne 0) { Die "failed to create venv" }
    } else {
        Info "reusing existing build venv"
    }

    # --- 2. dependencies ---
    Info "installing dependencies (this can take a few minutes the first time)"
    & $VenvPy -m pip install --upgrade pip
    & $VenvPy -m pip install -r (Join-Path $BackendRoot "requirements.txt")
    if ($LASTEXITCODE -ne 0) { Die "pip install -r requirements.txt failed" }
    # GPU runtime wheels (cuDNN 9 / cuBLAS) + PyInstaller. These pull large CUDA
    # DLLs; the spec collects them next to the exe. Safe on a CPU-only box too.
    & $VenvPy -m pip install "nvidia-cudnn-cu12==9.*" nvidia-cublas-cu12 pyinstaller
    if ($LASTEXITCODE -ne 0) { Die "pip install GPU/pyinstaller deps failed" }

    # --- 3. vendored binaries ---
    Info "fetching vendored binaries (ffmpeg.exe, vc_redist.x64.exe)"
    $vendorArgs = @{}
    if ($ForceVendor) { $vendorArgs["Force"] = $true }
    & (Join-Path $WinDir "fetch-vendor.ps1") @vendorArgs

    # --- 4. pyinstaller ---
    Info "building onedir bundle with PyInstaller"
    & $VenvPy -m PyInstaller $SpecPath --clean --noconfirm
    if ($LASTEXITCODE -ne 0) { Die "PyInstaller build failed" }
    if (-not (Test-Path $DistExe)) { Die "build did not produce $DistExe" }
    Ok "bundle built: $DistExe"

    # --- 5. smoke test ---
    Info "smoke test: run_server.exe --print-config"
    & $DistExe --print-config
    if ($LASTEXITCODE -ne 0) { Die "run_server.exe --print-config failed (exit $LASTEXITCODE)" }
    Ok "smoke test passed"

    # --- 6. installer (optional) ---
    if (-not $SkipInstaller) {
        $iscc = Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"
        if (Test-Path $iscc) {
            Info "compiling installer with Inno Setup (version $Version)"
            & $iscc "/DMyAppVersion=$Version" (Join-Path $WinDir "installer.iss")
            if ($LASTEXITCODE -ne 0) { Die "ISCC failed (exit $LASTEXITCODE)" }
            $out = Get-ChildItem (Join-Path $WinDir "Output") -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($out) { Ok "installer built: $($out.FullName)" }
        } else {
            Warn "Inno Setup not found - skipping installer."
            Warn "Install it (https://jrsoftware.org/isdl.php) or run: choco install innosetup"
            Warn "Then re-run, or just test the bundle directly (see below / use -Run)."
        }
    }

    Write-Host ""
    Ok "DONE."
    Write-Host "  Bundle:    $(Join-Path $BackendRoot 'dist\whisper-server')"
    Write-Host "  Installer: $(Join-Path $WinDir 'Output')  (if Inno Setup was present)"
    Write-Host "  Test the server without installing: run-built-server.bat (or -Run)"
    Write-Host ""

    # --- optional: launch the built server ---
    if ($Run) {
        Info "launching built server on http://127.0.0.1:8001 (Ctrl+C to stop)"
        Info "open http://127.0.0.1:8001/health and /version in a browser to verify"
        & $DistExe
    }
}
finally {
    Pop-Location
}
