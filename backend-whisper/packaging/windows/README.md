# SubSmelt Whisper Backend — Windows Build Runbook

Phase 3 of [`docs/windows-whisper-server-plan.md`](../../../docs/windows-whisper-server-plan.md).
This directory packages the existing `backend-whisper` FastAPI service into a
standalone Windows application: a PyInstaller `--onedir` bundle, an Inno Setup
installer, a Windows Service, and a system-tray controller.

> **These artifacts build and run on Windows only.** They are authored here on
> macOS/Linux but PyInstaller/Inno/`sc.exe`/`netsh` must be run on a Windows x64
> host (ideally Windows 10/11 with an NVIDIA GPU for GPU testing).

---

## Contents

| File | Purpose | Build-on-Windows? |
|---|---|---|
| `whisper-server.spec` | PyInstaller spec → `dist\whisper-server\` onedir bundle | yes |
| `../../run_server.py` | uvicorn launcher / frozen entrypoint (cross-platform) | runnable anywhere |
| `installer.iss` | Inno Setup installer (Program Files, VC++, service, firewall, driver gate, uninstaller) | yes (ISCC.exe) |
| `install-service.ps1` / `uninstall-service.ps1` | register/remove the auto-start service with crash recovery | yes (admin) |
| `tray/whisper_tray.py` | pystray/pillow tray controller | builds on Windows; imports anywhere |

`app/audio.py` was given an additive `SUBSMELT_FFMPEG` env hook so the bundled
`ffmpeg.exe` is used without relying on PATH. No other backend code changed.

---

## Prerequisites (Windows build host)

1. **Python 3.11 x64** (match the backend; 3.11-slim is the Docker base).
2. Install the backend + build deps into a clean venv:

   ```bat
   cd backend-whisper
   py -3.11 -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt

   :: PyInstaller bundler
   pip install pyinstaller

   :: CUDA runtime wheels (the #1 footgun — provides cudnn_ops64_9.dll / cublas64_12.dll)
   pip install nvidia-cudnn-cu12 nvidia-cublas-cu12

   :: GPU build of CTranslate2 (faster-whisper uses CTranslate2, NOT torch).
   :: faster-whisper pulls a ctranslate2 that targets CUDA 12; verify it imports
   :: and that ctranslate2.get_cuda_device_count() works on a GPU box.
   pip install --upgrade ctranslate2

   :: uvicorn programmatic server (already via requirements.txt's uvicorn[standard])

   :: Tray-build-only extras (NOT in requirements.txt, NOT needed by the server):
   pip install pystray pillow
   ```

3. A recent **NVIDIA display driver** on any box used for GPU smoke-testing. The
   full CUDA Toolkit is **not** required — the cuDNN/cuBLAS wheels above supply
   the runtime (plan §Phase 3a).

---

## Vendor files (required before building)

**Automatic (recommended):** run the fetch script — it downloads `ffmpeg.exe`
(BtbN static win64) and `vc_redist.x64.exe` (Microsoft permalink) into
`packaging\windows\vendor\`. Idempotent; `-Force` re-downloads. CI runs this same
script.

```powershell
pwsh packaging\windows\fetch-vendor.ps1
```

**Manual fallback:** create `packaging\windows\vendor\` and place:

| File | Where to get it | Used by |
|---|---|---|
| `ffmpeg.exe` | a static Windows build (e.g. gyan.dev / BtbN) | bundled into the onedir; launcher sets `SUBSMELT_FFMPEG` |
| `vc_redist.x64.exe` | Microsoft Visual C++ Redistributable (x64) | `installer.iss` installs it silently |
| `whisper.ico` *(optional)* | your icon | exe icon (enable the `icon=` line in the spec) |
| `provision.exe` *(Phase 3a, optional)* | built from the provision module | installer driver pre-check + tray diagnostics |

The `vendor\` dir is gitignored — these binaries are never committed.

> If `vc_redist.x64.exe` is missing at compile time, `ISCC` errors — that is the
> intended "you forgot to drop it in" guard. `ffmpeg.exe` absence only logs a note.

---

## Quickest path: one-click local build

Copy the whole repo to a Windows machine and **double-click
`packaging\windows\build-local.bat`**. It does everything below automatically:
creates a build virtualenv, installs deps + cuDNN/cuBLAS + PyInstaller, runs
`fetch-vendor.ps1`, builds the bundle, smoke-tests it, and (if Inno Setup is
installed) compiles the installer. Prereq: Python 3.10–3.13 on PATH (Inno Setup
optional — only needed for the `.exe` installer).

- **Test the server without installing:** double-click `run-built-server.bat`
  after the build, then open `http://127.0.0.1:8001/health` and `/version`.
- **From a terminal** you can pass flags: `build-local.bat -Run`,
  `build-local.bat -Version 0.5.0`, `build-local.bat -Clean`,
  `build-local.bat -SkipInstaller`.

The manual steps below are the same thing broken out, for when you want control.

---

## Build steps (manual)

```bat
cd backend-whisper

:: 1) Build the onedir bundle. Output: dist\whisper-server\run_server.exe
pyinstaller packaging\windows\whisper-server.spec --clean --noconfirm

:: 2) Smoke-test the frozen launcher (no GPU needed; CPU mode is fine):
dist\whisper-server\run_server.exe --check
dist\whisper-server\run_server.exe --print-config

:: 3) Compile the installer (requires Inno Setup's ISCC.exe on PATH):
iscc packaging\windows\installer.iss
:: Output: packaging\windows\Output\SubSmeltWhisperBackend-Setup-<ver>.exe
```

### Output locations
- onedir bundle: `backend-whisper\dist\whisper-server\`
- installer exe: `backend-whisper\packaging\windows\Output\`

The installer copies the bundle to `C:\Program Files\SubSmelt\WhisperBackend`,
installs VC++, runs the Phase 3a driver pre-check, registers the
`SubSmeltWhisper` service (auto-start + crash recovery), opens the firewall port
(default 8001), and creates `C:\ProgramData\SubSmelt\{models,media,logs}`.

---

## Models are NOT bundled

The installer ships **zero** model weights (plan Phase 3/3a). On first use the
**model manager** downloads the chosen model (`tiny`…`large-v3-turbo`) from the
official source (`Systran/faster-whisper-*`) into the configured model dir
(`C:\ProgramData\SubSmelt\models`, exported as `HF_HOME`). The backend refuses to
transcribe with a model that isn't present and surfaces a "download first"
action — never a silent multi-GB stall.

---

## Running / verifying after install

```powershell
# service state
sc.exe query SubSmeltWhisper
# health (replace port if you changed it)
Invoke-WebRequest http://127.0.0.1:8001/health
```

Use the tray app (Start/Stop service, Open logs, Model manager, Open config,
**Run diagnostics** → provision doctor). To run the tray during development:

```bat
python packaging\windows\tray\whisper_tray.py --status
python packaging\windows\tray\whisper_tray.py            # shows the tray (needs pystray+pillow)
```

---

## Configuration

The launcher (`run_server.py`) reads, in priority order, env vars then an
optional JSON config (`SUBSMELT_WHISPER_CONFIG`):

| Env var | Meaning | Default |
|---|---|---|
| `SUBSMELT_WHISPER_HOST` | bind host | `127.0.0.1` (`0.0.0.0` when a token is set) |
| `SUBSMELT_WHISPER_PORT` | bind port | `8001` |
| `SUBSMELT_WHISPER_MODEL_DIR` | model cache → `HF_HOME` | — |
| `SUBSMELT_WHISPER_TOKEN` | shared-secret bearer token (Phase 1) | — |
| `SUBSMELT_WHISPER_MEDIA_ROOT` | allowed media root → `MEDIA_ROOT` | — |
| `SUBSMELT_FFMPEG` | path to bundled `ffmpeg.exe` | `ffmpeg` on PATH |

`install-service.ps1` writes these as **machine-scope** env vars so the
LocalSystem service sees them.

---

## CI (Phase 6) — implemented

The build runs automatically in **`.github/workflows/windows-whisper-build.yml`**
on a `windows-latest` runner. It triggers on `whisper-v*` tags (decoupled from the
Docker `v*` tags because the CUDA onedir is ~1–2 GB) and via manual
`workflow_dispatch` (with a `version` input). Steps:

1. resolve version (from the `whisper-v<ver>` tag or the dispatch input),
2. install `requirements.txt` + `nvidia-cudnn-cu12` / `nvidia-cublas-cu12` + PyInstaller,
3. `fetch-vendor.ps1` → `vendor\ffmpeg.exe` + `vendor\vc_redist.x64.exe`,
4. `pyinstaller … whisper-server.spec`, then smoke-test `run_server.exe --help`,
5. `choco install innosetup`, then `ISCC /DMyAppVersion=<ver> installer.iss`,
6. upload the `Output\*.exe` installer as a build artifact, and — on a tag —
   attach it to a GitHub release.

**To cut a release:** push a tag like `whisper-v0.5.0`. **To test the build
without a release:** run the workflow manually from the Actions tab.

> Not yet in CI (future work): a full packaging smoke test that *installs* the
> service and asserts `/health` returns 200 (needs a GPU-or-CPU service-lifecycle
> step), and code signing of the installer.

---

## Troubleshooting

- **`cudnn_ops64_9.dll` / `cublas64_12.dll` not found** — the cuDNN/cuBLAS wheels
  weren't collected. Confirm `pip show nvidia-cudnn-cu12 nvidia-cublas-cu12`
  before building; the spec's `collect_dynamic_libs` pulls them and the launcher's
  `add_dll_directory` puts them on the search path. `run_server.exe --check`
  prints a clear CUDA probe message.
- **GPU not detected** — update the NVIDIA driver; the server falls back to CPU.
- **Service won't start** — check `C:\ProgramData\SubSmelt\logs`; run
  `run_server.exe --check` manually to see the startup diagnostics.
