# Plan: Remote Whisper Backend — Windows CUDA Executable

> Goal: ship a standalone Windows application that runs the SubSmelt Whisper
> backend with NVIDIA CUDA acceleration, downloads/manages models, and serves
> transcription to a SubSmelt instance running on another machine.

## 0. Context & what already exists

The server is **not** new. `backend-whisper/` is a working FastAPI service
(`/health`, `/preflight`, `/transcribe`, `/transcribe/stream`, `/capabilities`)
that SubSmelt already drives via `src/server/transcription-client.ts`. This plan
**packages and remote-hardens that service** — it does not rewrite it.

What's missing for a real *remote Windows GPU* deployment:
1. **CUDA is not actually wired** — `/capabilities` hardcodes `["cpu"]`; `device`
   is accepted but the image/deps are CPU-only.
2. **File access assumes a shared filesystem** — `/transcribe` takes a *path*
   the backend reads from its own disk and writes output next to. A remote box
   doesn't see the client's media unless storage is shared.
3. **No auth / no TLS** — fine on localhost, unsafe across a network.
4. **No Windows packaging** — no exe, installer, service, model-download UX.

## 1. The decision that gates everything: file transport

| Model | Mechanism | Pros | Cons |
|---|---|---|---|
| **A. Shared storage** | GPU box mounts the same media (SMB/NFS); existing `path_map_from/to` remaps the prefix. **Works with today's protocol.** | Zero protocol change; large files never copied | Requires a shared mount across OSes; brittle perms; not "remote" in spirit |
| **B. Upload** | Client uploads the (extracted) audio; server returns subtitle **content** (not a path); client writes it locally | True remote, no shared FS, firewall-friendly | New protocol + endpoint; upload bandwidth (mitigated by extracting 16 kHz mono WAV client-side or letting server extract) |

**Recommendation:** support **both**, default to **B (upload)** for the Windows
remote case, keep **A** as a zero-config fallback when `path_map` is set and the
path resolves on the server. B is what "remote backend" actually means.

**Upload optimization:** SubSmelt (or the server) extracts audio to 16 kHz mono
WAV before/at transfer — a 2 h video's audio is ~110 MB, not multi-GB. Optionally
client-side ffmpeg extraction so only audio crosses the wire.

## 2. Phased work breakdown

### Phase 0 — Real CUDA wiring (backend, prereq for everything)
*Benefits the Docker GPU path too; do first, testable now.*
- Runtime GPU detection via `ctranslate2.get_cuda_device_count()` (faster-whisper
  uses CTranslate2, **not** torch).
- `/capabilities`: advertise real `devices` (`cpu` + `cuda` when present) and
  `computeTypes` (`int8`, `float16`, `int8_float16` on GPU).
- `transcribe.py`: validate the `device`/`compute_type` pairing; clean fallback
  to CPU with a clear error if CUDA requested but unavailable.
- **Preflight uses VRAM, not system RAM**, when device=cuda (current RAM table is
  wrong for GPU). Add VRAM detection (`nvidia-ml-py`/`pynvml`).
- CUDA OOM → typed error suggesting a smaller model.
- Files: `backend-whisper/app/{main,transcribe,preflight,model_loader}.py`,
  `requirements.txt` (+`ctranslate2` CUDA, `nvidia-ml-py`).

### Phase 1 — Remote hardening (auth + binding)
- **Shared-secret token**: optional `SUBSMELT_WHISPER_TOKEN`; when set, every
  request must carry `Authorization: Bearer <token>` (or `X-Subsmelt-Token`).
  Reject 401 otherwise. Health may stay open or also gated (config).
- SubSmelt side: new setting `transcription_backend_token`, sent as a header by
  `transcription-client.ts` on all calls.
- **Binding/TLS**: default bind `0.0.0.0` only when a token is set; otherwise
  `127.0.0.1`. Document putting it behind a reverse proxy for TLS, or add
  optional self-signed/`--cert` support.
- Keep the existing `assert_path_under_media` guard with a Windows `MEDIA_ROOT`.

### Phase 2 — Upload transport (Model B) — ✅ implemented
- New `POST /transcribe/upload` (multipart or chunked stream): accepts the media/
  audio bytes + the same `TranscribeRequest` fields (minus `input_path`).
- Server writes to a temp dir, runs the existing pipeline, returns subtitle
  **content** (string) + `language`/`segments`/`duration_seconds` instead of a
  path. Streaming variant emits the same NDJSON progress then a terminal result
  carrying `content`.
- Cleanup temp on success/cancel/disconnect (reuse the existing disconnect-cancel
  watcher).
- SubSmelt side: a transport mode setting (`auto`/`shared`/`upload`); in upload
  mode it reads the file, optionally extracts audio, uploads, writes the returned
  content to the local output path. Falls back to path mode when configured.
- Keep `/transcribe` + `/transcribe/stream` (path mode) unchanged for Model A.

  **As built:** `POST /transcribe/upload` + `/transcribe/upload/stream` (multipart
  `file` + `request` JSON; returns subtitle `content`, not a path; NDJSON progress
  + disconnect-cancel + temp cleanup). Client: `transcription_transport`
  (`auto`/`shared`/`upload`, default `auto` → upload when a token is set with no
  path map). `transcribeWithBackendUpload[Streaming]` stream the local file via
  `openAsBlob` (no full in-memory copy) and write the returned content locally.
  Upload mode skips the path-mode HTTP `/preflight` (no server path); the upload
  endpoint runs its own resource/model-downloaded gate.
  **Follow-ups:** client-side audio extraction to shrink uploads (currently the
  backend extracts), and low-RAM auto-downgrade in upload mode (path-mode only now).

### Phase 3 — Windows packaging
- **Bundler**: PyInstaller **`--onedir`** (not onefile — CTranslate2 + CUDA DLL
  discovery + multi-GB models make onefile painful). Alternatively Nuitka.
- **CUDA runtime**: ship cuBLAS + cuDNN via pip wheels `nvidia-cublas-cu12` +
  `nvidia-cudnn-cu12` (avoids requiring a full CUDA Toolkit install on the target).
  This is the #1 footgun ("cudnn_ops64_9.dll not found"); verify DLL load at
  startup with a clear diagnostic.
- **ffmpeg**: bundle `ffmpeg.exe`; point `audio.py` at the bundled path via env/
  arg (don't rely on PATH).
- **Installer**: Inno Setup — installs to Program Files, bundles VC++ redist,
  registers the service, adds a **Windows Firewall** rule for the port, checks
  NVIDIA driver version, provides uninstaller.
- **Service**: run as a Windows Service (NSSM or `sc.exe`) — auto-start, survives
  logout, recovery/restart on crash.
- **System tray app**: status (idle/transcribing/%), start/stop, open logs, open
  model manager, edit config. (Small C#/.NET or Python `pystray` app, or a tiny
  Tauri/Electron shell.)
- **Model manager** (models are **NOT bundled** — user downloads on demand): the
  installer ships **zero** model weights. A dedicated model-manager UI lets the
  user:
  - See the available models (tiny / base / small / medium / large-v3 /
    large-v3-turbo) with **download size, disk-after-install, and VRAM/RAM need**
    per model, plus which are already downloaded.
  - **Download** a chosen model on demand (progress bar, pause/resume, free-disk
    pre-check, integrity/hash verify) into a configurable model dir.
  - **Delete** downloaded models to reclaim disk.
  - **Import offline**: point at a pre-downloaded model folder for air-gapped
    machines (no internet at install time).
  - Models download from the official source (HF `Systran/faster-whisper-*`) at
    the user's choice — never silently, never as part of the package.
  - The backend refuses to transcribe with a model that isn't downloaded yet and
    surfaces a "download <model> first" action — first transcription is never a
    silent multi-GB stall.
- **Config**: file + tray UI for host/port, token, model dir, allowed media
  roots, max concurrency, GPU device index, transport mode.

### Phase 3a — Hardware/software detection & provisioning (setup wizard)

The installer/first-run wizard must **detect** the system and **install the
required software**, surfacing a green/red checklist with a "fix" action per row.

**Key simplification:** the **full CUDA Toolkit is NOT required**. CTranslate2 +
the bundled `nvidia-cudnn-cu12`/`nvidia-cublas-cu12` wheels provide the CUDA
*runtime*. The only host prerequisite for GPU is a recent **NVIDIA display
driver**. This drastically shrinks what must be provisioned.

**Detection matrix (what to probe):**
| Item | How to detect | Action if missing/old |
|---|---|---|
| GPU model + VRAM | `nvidia-smi`, NVML (`pynvml`), or WMI `Win32_VideoController` | If no NVIDIA GPU → offer CPU-only mode |
| NVIDIA driver + version | `nvidia-smi --query-gpu=driver_version`, registry, NVML | Guide/fetch driver if below min (see below) |
| CUDA runtime capability | CTranslate2 `get_cuda_device_count()` after DLLs load | Re-check after driver install |
| CPU cores / RAM | `psutil` / WMI | Warn if under model minimums |
| Free disk (model dir) | `shutil.disk_usage` | Block model download if insufficient |
| OS version / arch | `platform` / WMI | Require Win10+ x64 |
| VC++ redistributable | registry / presence of msvcp140.dll | Install bundled redist (silent) |
| ffmpeg | bundled (always present) | n/a — shipped with app |
| Existing service/port | `sc query`, port bind test | Offer to reconfigure port |

**Provisioning tiers — what we can vs can't auto-install:**
- **Bundled, installed silently (app-local, no driver risk):** Python runtime,
  CTranslate2 + faster-whisper, cuDNN/cuBLAS wheels, ffmpeg.exe, VC++ redist.
  These ship inside the installer — zero network needed, no admin driver surgery.
- **NVIDIA driver — DETECT, then GUIDED install with explicit consent (never
  silent-forced):** drivers are large, GPU-specific, need admin + often a reboot,
  and NVIDIA's EULA restricts blind redistribution. Approach:
  1. Detect installed driver version; compare to a pinned **minimum** (the min
     that satisfies the CUDA 12 / cuDNN 9 runtime CTranslate2 needs).
  2. If missing/too old: show a clear prompt with the GPU model + required
     version, and offer **(a)** "Download driver" (open NVIDIA's official driver
     page pre-filtered to the detected GPU) or **(b)** "Download & install for me"
     — fetch the official NVIDIA installer and run it with `-s` (silent) **only
     after the user consents**, then re-probe and prompt for reboot if required.
  3. Always allow **Skip → CPU-only mode** so the app is never bricked by a
     driver step.
  - Rationale: auto-installing the wrong/forced driver can destabilize a system;
    consent + official-source fetch is the safe, standard pattern (matches how
    GeForce Experience / vendor tools behave).
- **Re-runnable "doctor":** the same checklist is available post-install from the
  tray ("Run diagnostics") so users can re-validate after a driver/OS change.

**Failure-mode UX:** every check that fails shows *what's wrong*, *why it matters*,
and *the fix button*. cuDNN load failure (the #1 footgun) is its own check with a
"repair runtime" action. Never let transcription fail with a raw DLL error.

**Implementation notes:** detection logic lives in a small `provision/` module
(Python or the tray app's language); the installer (Inno Setup) calls it for the
pre-install gate, and the tray app reuses it for the doctor. Keep driver fetch
URLs/min-versions in a config the app can update without a rebuild.

### Phase 4 — SubSmelt client integration
- Settings: `transcription_backend_token`, transport mode, (existing) backend URL
  + path map.
- Send auth header; handle 401 with a clear message.
- Readiness panel: show CUDA/float16 from the now-real `/capabilities`; show
  server version + transport mode; "test connection" includes auth.
- Upload-mode wiring (Phase 2 client half).

### Phase 5 — Ops & lifecycle
- File logging + rotation (no console on a service); log level config.
- `/version` endpoint; health includes GPU/driver/model-cache status.
- Graceful shutdown: finish or cancel in-flight (disconnect-cancel exists).
- Auto-update: check a release feed, download, swap, restart service (or manual
  installer). Model integrity (hash) checks.

### Phase 6 — Build, test, docs
- **CI**: a GitHub Actions Windows runner builds the exe/installer on tag (mirror
  the existing `docker-publish.yml` tag-trigger pattern), uploads the installer as
  a release asset.
- Tests: CUDA-path unit tests (mocked), upload endpoint tests, auth tests,
  packaging smoke test (installer runs, service starts, `/health` 200).
- Docs: install guide, GPU/driver prereqs, firewall, connecting SubSmelt, model
  download, troubleshooting (cuDNN, driver mismatch, OOM).

## 3. Protocol additions (summary)

```
POST /transcribe/upload         (multipart: file + JSON fields)
  -> { ok, content, language, segments, duration_seconds }   # content, not path
POST /transcribe/upload/stream  -> NDJSON progress + terminal { ok, content, ... }
GET  /version                   -> { version, capabilities, transportModes }
Auth: Authorization: Bearer <token>  (when token configured) on all routes
```
Existing path-mode routes unchanged (Model A).

## 4. Risks (ranked) & mitigations
1. **cuDNN/cuBLAS DLL packaging** — verify at startup, ship via pip wheels, clear
   error + docs.
2. **File-transport mismatch** — support both; default upload; document A vs B.
3. **No auth over network** — token + bind rules in Phase 1 before any remote use.
4. **Model download UX** — explicit manager + progress + disk check.
5. **Service lifecycle on Windows** — NSSM recovery; smoke-tested in CI.
6. **GPU/driver variance** — driver-version check in installer; CPU fallback.
7. **Installer size** (CUDA DLLs + onedir) — accept ~1–2 GB; models downloaded
   post-install, not bundled.

## 5. Recommended sequencing
1. **Phase 0 (CUDA)** — start now, lands in the repo, helps Docker GPU immediately.
2. **Phase 1 (auth/bind)** — small, unblocks any remote use safely.
3. **Phase 2 (upload)** — the real "remote" enabler.
4. **Phase 3 (packaging)** — the Windows exe/installer/service/tray/model-manager.
5. **Phases 4–6** in parallel with 3 (client integration, ops, CI/docs).

MVP for "a Windows box transcribes for a remote SubSmelt": **Phases 0 + 1 + 3**
with **Model A** (shared SMB) — skips the upload protocol. Full remote (no shared
storage) needs **Phase 2** too.

## 6. Open decisions (need your call)
- **Transport**: ship upload (B) in MVP, or start shared-storage (A) only?
- **Tray app stack**: C#/.NET, Python `pystray`, or a small Tauri shell?
- **Packaging**: PyInstaller vs Nuitka; Inno Setup vs MSIX.
- **Auth**: shared token only, or also TLS in-app vs reverse-proxy?
- **Distribution**: GitHub Releases asset, or a separate signed installer (code-
  signing cert needed to avoid SmartScreen warnings)?
