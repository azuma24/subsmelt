# SubSmelt Whisper Backend — Windows Build Runbook

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
| `../../winservice.py` | Windows Service entry (`run_server.exe --service`): pywin32 `ServiceFramework` running uvicorn in-process | imports anywhere; runs on Windows |
| `installer.iss` | Inno Setup installer (Program Files, VC++, service, firewall, driver gate, uninstaller) | yes (ISCC.exe) |
| `install-service.ps1` / `uninstall-service.ps1` | register/remove the auto-start service with crash recovery; write/remove `config.json` | yes (admin) |
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

   :: PyInstaller bundler + pywin32 for the Windows Service entry (winservice.py).
   :: Both are Windows-build-only and deliberately not in requirements.txt.
   pip install pyinstaller pywin32

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
   the runtime (plan §Phase 3a). The Nemotron 3.5 ASR engine needs driver
   **R580 or newer** for GPU use (see below).

---

## Vendor files (required before building)

**Automatic (recommended):** run the fetch script — it downloads `ffmpeg.exe`
(a pinned, SHA-256 verified BtbN win64 release build), `vc_redist.x64.exe`
(Microsoft permalink) and the pinned, SHA-256 verified NeMo-Speech.cpp runtime
into `packaging\windows\vendor\`. Idempotent: each item keeps a
`vendor\<name>.version` marker and is re-fetched when the pin at the top of the
script changes; `-Force` re-downloads everything. CI runs this same script.

```powershell
pwsh packaging\windows\fetch-vendor.ps1
```

**Manual fallback:** create `packaging\windows\vendor\` and place:

| File | Where to get it | Used by |
|---|---|---|
| `ffmpeg.exe` | a static Windows build (e.g. gyan.dev / BtbN) | bundled into the onedir; launcher sets `SUBSMELT_FFMPEG` |
| `vc_redist.x64.exe` | Microsoft Visual C++ Redistributable (x64) | `installer.iss` installs it silently |
| `nemo-speech\bin\` | the `bin\` folder of `nemo-speech-0.1.0-windows-x86_64-cuda.zip` from the [NeMo-Speech.cpp v0.1.0 release](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.1.0) | bundled as `nemo-speech\bin\` in the onedir; the service gets `SUBSMELT_NEMO_SPEECH` |
| `whisper.ico` *(optional)* | your icon | exe icon (enable the `icon=` line in the spec) |
| `provision.exe` *(Phase 3a, optional)* | built from the provision module | installer driver pre-check + tray diagnostics |

The `vendor\` dir is gitignored — these binaries are never committed.

> If `vc_redist.x64.exe` is missing at compile time, `ISCC` errors — that is the
> intended "you forgot to drop it in" guard. `ffmpeg.exe` or `nemo-speech\bin\`
> absence only logs a note, but CI fails the build when `nemo-speech.exe` is
> missing from the bundle.

### NeMo-Speech runtime (Nemotron 3.5 ASR)

The Nemotron 3.5 ASR engine runs through `nemo-speech.exe` from
[NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) v0.1.0, not through
faster-whisper. `fetch-vendor.ps1` pins the release zip by version and SHA-256
(both at the top of the script) and throws when the hash does not match. It
copies only the zip's `bin\` folder (`nemo-speech.exe` and its DLLs, including
`cublas64_13.dll`); `include\` and `lib\` are build-time files and are dropped.

- The installed layout is
  `C:\Program Files\SubSmelt\WhisperBackend\nemo-speech\bin\nemo-speech.exe`.
- `install-service.ps1` writes that path as `nemo_speech` in `config.json`.
  Without it, the backend looks in `<exe dir>\nemo-speech\bin\` and then on
  `PATH`.
- It is a **CUDA 13** build, so GPU use needs an NVIDIA driver **R580 or newer**.
  Whisper models keep working on older drivers.
- No model is bundled. Download Nemotron 3.5 ASR (a 742 MB GGUF) from SubSmelt ->
  Settings after install.

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
- **Native GUI app (recommended):** double-click `run-gui.bat`. Opens a real
  window to pick bind host (127.0.0.1 / 0.0.0.0) + port + API key (with a
  **Generate** button that mints one and copies it to the clipboard), then
  Start / Stop / Restart the server, read `/health` (version, GPU, ffmpeg,
  models), and open the health page / logs / config. **Closing the window hides
  it to the system tray** (the server keeps running); the tray icon restores it
  or quits (Quit stops the server). No console window. `build-local.bat` builds
  `whisper-gui.exe`.
- **Tray-only (no window):** double-click `run-tray.bat` — a tray icon with
  Start / Stop / Restart / Open health page / Open logs / Quit. `build-local.bat`
  builds `whisper-tray.exe`. Skip both extra exes with `-SkipTray`.
- **API key:** the backend can mint its own. In the GUI app, press **Generate**
  next to the API key field — it produces a 256-bit key and copies it to the
  clipboard; paste it into **SubSmelt → Settings → Speech to Text → Backend
  token**, then press **Start** (or **Restart**) to apply it. Headless installs
  use the launcher instead:

  ```
  run_server.exe --generate-token          :: print a key, change nothing
  run_server.exe --generate-token --save   :: also write it to config.json
  run_server.exe --generate-token --save --force   :: rotate an existing key
  ```

  `--save` refuses to replace a stored token without `--force`, because
  rotating the key makes every client still using the old one fail with 401.
- **Remote/LAN access:** the server binds `0.0.0.0` by default, because SubSmelt
  normally runs in Docker or on another machine and could not reach a
  loopback-only backend. **Without `SUBSMELT_WHISPER_TOKEN` set, every host on
  your network can use the backend** — the launcher warns loudly at startup when
  it binds wide with no token. Set a token (see **API key** above, or
  `set SUBSMELT_WHISPER_TOKEN=<secret>` before launching; or
  `SUBSMELT_WHISPER_HOST=127.0.0.1` for a local-only backend), and open the
  firewall port on the private and domain profiles only:
  `netsh advfirewall firewall add rule name="SubSmelt Whisper" dir=in action=allow protocol=TCP localport=8001 profile=private,domain`.
- **From a terminal** you can pass flags: `build-local.bat -Run`,
  `build-local.bat -Version 0.5.6`, `build-local.bat -Clean`,
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

The installer stops a running `SubSmeltWhisper` service, copies the bundle to
`C:\Program Files\SubSmelt\WhisperBackend`, installs VC++, runs the Phase 3a
driver pre-check, registers the service through `install-service.ps1`
(auto-start + crash recovery; a failure is shown, not swallowed), opens the
firewall port (default 8001, private and domain profiles, replacing any rule of
the same name), and creates `C:\ProgramData\SubSmelt\{models,media,logs}`.

### Service, token and finish page

- The service's binary path is `"...\run_server.exe" --service`. With that
  flag the launcher hands the process to the Service Control Manager
  (`winservice.py`): start reports RUNNING and runs uvicorn in-process, stop
  reports STOP_PENDING and asks uvicorn to exit. Registering plain
  `run_server.exe` fails with error 1053, because it never reports a status.
- `install-service.ps1` runs with `-GenerateToken`: a fresh install always
  gets a token. On an upgrade the token already in `config.json` is kept, so
  SubSmelt keeps working with the key it has.
- The finish page shows the backend URL and the token, read from
  `C:\ProgramData\SubSmelt\backend-info.txt`, and offers to open that file.
  Like `config.json`, it is readable by administrators and SYSTEM only.
- The script's output goes to `C:\ProgramData\SubSmelt\logs\install-service.log`
  (never the token).

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

### Verify on Windows

The service path cannot be exercised on macOS/Linux or on the GPU-less CI
runner, so check these by hand on a Windows box after a build:

1. Install with the setup exe. The finish page shows the backend URL and token.
2. `sc query SubSmeltWhisper` reports `RUNNING` within 60 s of the install
   finishing (no error 1053 in the Event Log).
3. `Invoke-WebRequest http://127.0.0.1:<port>/health` returns 200 on the port
   chosen in the wizard.
4. `Invoke-WebRequest http://127.0.0.1:<port>/logs`: every uvicorn line
   appears once, not three times.
5. `icacls C:\ProgramData\SubSmelt\config.json` lists only `NT AUTHORITY\SYSTEM`
   and `BUILTIN\Administrators` (both `F`); `icacls C:\ProgramData\SubSmelt`
   gives `BUILTIN\Users` `RX` only.
6. `netsh advfirewall firewall show rule name="SubSmelt Whisper Backend"` shows
   one rule with `Profiles: Domain,Private`.
7. Run the installer again over the existing install: it stops the service
   first, `config.json` keeps the same token, and the service is `RUNNING`
   again afterwards.
8. Tray: Start service / Stop service show a UAC prompt and change
   `sc query` state; a declined prompt shows a notification, not silence.
9. Uninstall from Apps & features: the service and the firewall rule are gone;
   `config.json` and `backend-info.txt` are removed; models, media and logs
   stay.

Use the tray app (Start/Stop service, Open logs, Model manager, Open config,
**Run diagnostics** → `run_server --check`). Start/Stop go through a UAC prompt:
the tray is not elevated and `sc.exe` requires an administrator. To run the
tray during development:

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
| `SUBSMELT_WHISPER_HOST` | bind host | `0.0.0.0` (set `127.0.0.1` for local-only) |
| `SUBSMELT_WHISPER_PORT` | bind port | `8001` |
| `SUBSMELT_WHISPER_MODEL_DIR` | model cache → `HF_HOME` | — |
| `SUBSMELT_WHISPER_TOKEN` | shared-secret bearer token (Phase 1); generate one with `run_server --generate-token` | — |
| `SUBSMELT_WHISPER_MEDIA_ROOT` | allowed media root → `MEDIA_ROOT` | — |
| `SUBSMELT_FFMPEG` | path to bundled `ffmpeg.exe` | `ffmpeg` on PATH |
| `SUBSMELT_NEMO_SPEECH` | path to bundled `nemo-speech.exe` (Nemotron ASR); config key `nemo_speech` | `<exe dir>\nemo-speech\bin\nemo-speech.exe`, then `nemo-speech` on PATH |
| `SUBSMELT_DATA_DIR` | data dir holding `config.json` + `logs\` | `C:\ProgramData\SubSmelt` |
| `SUBSMELT_WHISPER_CONFIG` | JSON config file | `<data dir>\config.json` |
| `SUBSMELT_WHISPER_LOG_FILE` | rotating log file (5 MB x 5) | `<data dir>\logs\whisper-server.log` |
| `SUBSMELT_WHISPER_VERSION` | version reported by `/health`; config key `version` | stamped by the installer |

### `config.json`

`install-service.ps1` writes the installed service's settings to
`C:\ProgramData\SubSmelt\config.json` (keys `port`, `model_dir`, `media_root`,
`ffmpeg`, `nemo_speech`, `log_file`, `version`, `token`), which `run_server.exe`
reads on every start. Keys it does not own (`host`, `log_level`) and an existing
`token` are preserved on upgrade. Earlier installers stored the same settings as
machine-scope environment variables; a service only sees those after a reboot,
and once it does they override the file, so both install and uninstall scripts
remove them.

The file holds the token, so it is readable by SYSTEM and Administrators only;
the data dir itself is read-only for Users (`media\` stays writable, it is the
drop folder). Edit it through the Start-menu "Open Whisper Config" shortcut,
which elevates, or from an elevated editor, then restart the service. The
control window (`whisper-gui.exe`) runs unelevated and cannot read or save it;
it reports "Could not save" and uses the values in its own fields for the
server it launches itself.

A `log_file` in `config.json` is honoured only inside
`C:\ProgramData\SubSmelt\logs`; anything else is logged as a warning and the
default is used, so an edit cannot make the SYSTEM service write elsewhere.

---

## CI (Phase 6) — implemented

The build runs automatically in **`.github/workflows/windows-whisper-build.yml`**
on a `windows-latest` runner. It triggers on `whisper-v*` tags (decoupled from the
Docker `v*` tags because the CUDA onedir is ~1–2 GB) and via manual
`workflow_dispatch` (with a `version` input). Steps:

1. resolve version (from the `whisper-v<ver>` tag or the dispatch input),
2. install `requirements.txt` + `nvidia-cudnn-cu12` / `nvidia-cublas-cu12` + PyInstaller + pywin32,
   all pinned to `constraints.txt` through `PIP_CONSTRAINT` (`build-local.ps1` does the same),
3. `fetch-vendor.ps1` → `vendor\ffmpeg.exe` + `vendor\vc_redist.x64.exe` +
   `vendor\nemo-speech\bin\`,
4. `pyinstaller … whisper-server.spec`, then smoke-test `run_server.exe --print-config`
   and fail if `nemo-speech\bin\nemo-speech.exe` is missing from the bundle (the
   CUDA exe is not run; the runner has no GPU), then start the frozen server, wait for
   `/health`, and transcribe a WAV with Whisper `tiny` on CPU through the bundled
   `ffmpeg.exe`,
5. `choco install innosetup`, then `ISCC /DMyAppVersion=<ver> installer.iss`,
6. upload the `Output\*.exe` installer as a build artifact, and — on a tag —
   attach it to a GitHub release.

**To cut a release:** push a tag like `whisper-v0.5.6`. **To test the build
without a release:** run the workflow manually from the Actions tab.

> Not yet in CI (future work): installing the service itself (the smoke tests run
> `run_server.exe` directly), any GPU path, and code signing of the installer.

---

## Troubleshooting

- **`cudnn_ops64_9.dll` / `cublas64_12.dll` not found** — the cuDNN/cuBLAS wheels
  weren't collected. Confirm `pip show nvidia-cudnn-cu12 nvidia-cublas-cu12`
  before building; the spec's `collect_dynamic_libs` pulls them and the launcher's
  `add_dll_directory` puts them on the search path. `run_server.exe --check`
  prints a clear CUDA probe message.
- **GPU not detected** — update the NVIDIA driver; the server falls back to CPU.
- **Nemotron shows "Runtime missing"** — check that
  `nemo-speech\bin\nemo-speech.exe` exists next to `run_server.exe` and that
  `SUBSMELT_NEMO_SPEECH` points at it (`run_server.exe --print-config` lists it
  as `nemo_speech`). For GPU speed, update the driver to R580 or newer.
- **Service won't start** — check `C:\ProgramData\SubSmelt\logs`
  (`install-service.log` for the registration, `whisper-server.log` for the
  server); run `run_server.exe --check` manually to see the startup
  diagnostics. Error 1053 means the registered binary path lacks `--service`:
  re-run `install-service.ps1` from an elevated PowerShell.
- **"Access is denied" on `config.json`** — it is readable by administrators
  only. Use the elevated "Open Whisper Config" shortcut.
