# SubSmelt Whisper backend for macOS

This folder builds and installs the speech-to-text backend on an Apple Silicon Mac. The app runs Nemotron 3.5 ASR on the GPU through Metal, and Whisper on the CPU. It ships no models. You download the models you want from SubSmelt's model manager after you install.

## Install

1. Download `subsmelt-whisper-macos-arm64-<version>.zip` from the `whisper-v<version>` release and unzip it. You get a folder named `SubSmelt Whisper`.
2. Open Terminal and run the installer from that folder:

   ```bash
   bash ~/Downloads/"SubSmelt Whisper"/install-launchd.sh
   ```

   Options: `--port 8001`, `--media-root <folder>` and `--model-dir <folder>`. Without them, the installer keeps the values already in `config.json`, or uses port 8001 and folders under `~/Library/Application Support/SubSmelt`.
3. Open `~/Library/Application Support/SubSmelt/backend-info.txt`. It holds the backend URL and token.
4. In SubSmelt, open Settings, then Speech to Text. Paste the URL and the token.
5. Open the model manager in SubSmelt and download a model, for example Nemotron 3.5 ASR.

The first time another computer connects, macOS asks whether `whisper-server` may accept incoming network connections. Select **Allow**. The installer adds no firewall rule.

### What the installer does

- It copies the app to `~/Applications/SubSmelt Whisper/` and removes the download quarantine flag from it. The app is not signed, and Gatekeeper refuses to start a quarantined unsigned binary from launchd.
- It writes `port`, `media_root`, `model_dir` and `token` to `~/Library/Application Support/SubSmelt/config.json` with mode `0600`. Other keys you added stay. A reinstall keeps the existing token. A new token is made only when none is stored.
- It writes the launchd agent `~/Library/LaunchAgents/com.subsmelt.whisper.plist`. The plist holds only the program path, so `config.json` stays the one place for settings. The agent starts at login and restarts after a crash.
- It writes `backend-info.txt` next to `config.json` with mode `0600`. The token is never printed to the terminal.

To change a setting later, edit `config.json` and restart the agent:

```bash
launchctl kickstart -k gui/$(id -u)/com.subsmelt.whisper
```

To run the backend by hand instead of under launchd, start `whisper-server/whisper-server` from the unzipped folder. If macOS says the app is damaged or from an unidentified developer, clear the quarantine flag first:

```bash
xattr -dr com.apple.quarantine ~/Downloads/"SubSmelt Whisper"
```

## Where things are

| What | Where |
|---|---|
| App | `~/Applications/SubSmelt Whisper/whisper-server/` |
| Settings and token | `~/Library/Application Support/SubSmelt/config.json` |
| Models (default) | `~/Library/Application Support/SubSmelt/models/` |
| Logs | `~/Library/Logs/SubSmelt Whisper/` (`whisper-server.log`, rotated at 5 MB, plus launchd's `stdout.log` and `stderr.log`) |

## Uninstall

```bash
bash ~/Applications/"SubSmelt Whisper"/uninstall-launchd.sh
```

This stops the agent and removes the app, the plist, `config.json` and `backend-info.txt`. Add `--keep-config` to keep `config.json` and its token for a reinstall. Models, media and logs stay.

## Transcription transport

SubSmelt on another machine uses the upload transport. It sends the video to the backend and gets the subtitles back, so you set up no shared folder and no path mapping. A backend on the same machine as SubSmelt reads media straight from `media_root`.

Run the backend natively, not in Docker. Docker on macOS has no access to the GPU.

## Build

The build needs an Apple Silicon Mac, [uv](https://docs.astral.sh/uv/), curl and the Xcode command line tools.

```bash
backend-whisper/packaging/macos/build.sh [out dir]
```

The default out dir is `backend-whisper/build/macos`. The build does these steps:

1. It creates a Python 3.12 venv and installs `requirements.txt` and PyInstaller, pinned by `packaging/windows/constraints.txt`.
2. It runs `fetch-vendor.sh <out dir>/vendor`. This downloads NeMo-Speech.cpp 0.1.0 for Metal and builds a minimal audio-only ffmpeg 7.1.2 that links only macOS system libraries. Both downloads are SHA-256 verified. A runtime is rebuilt only when its pin changes or `--force` is given. Set `SUBSMELT_VENDOR_CACHE` to a folder to reuse the downloaded archives between builds.
3. It freezes `run_server.py` with `whisper-server.spec` into `<out dir>/dist/whisper-server/`, with `nemo-speech/` and `ffmpeg/` beside the executable.
4. It zips the app, the two scripts, the plist template and this README as `<out dir>/dist/subsmelt-whisper-macos-arm64-<version>.zip`. The version comes from `app/version.py`.

`.github/workflows/macos-whisper-build.yml` runs the same build on `whisper-v*` tags and attaches the zip to the release.

## Licences

The bundled ffmpeg is built from the unmodified ffmpeg 7.1.2 source (https://ffmpeg.org/releases/ffmpeg-7.1.2.tar.xz) under the LGPL 2.1. Its licence files are in `whisper-server/ffmpeg/`. NeMo-Speech.cpp's licences are in `whisper-server/nemo-speech/share/licenses/`.
