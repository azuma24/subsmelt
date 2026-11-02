#!/bin/bash
# Build the macOS (Apple Silicon) backend zip:
#
#   <out dir>/dist/whisper-server/                          the frozen onedir app
#   <out dir>/dist/subsmelt-whisper-macos-arm64-<ver>.zip   what users download
#
# The zip holds one folder, "SubSmelt Whisper/", with the app, the launchd
# install and uninstall scripts, the plist template and the README.
#
# Usage: build.sh [out dir]     (default: backend-whisper/build/macos)
#
# Needs uv, curl and the Xcode command line tools (ffmpeg is compiled from
# source). Set SUBSMELT_VENDOR_CACHE to reuse downloaded archives.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PYTHON_VERSION="3.12"
APP_FOLDER="SubSmelt Whisper"

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || {
  echo "[build] this build targets Apple Silicon macOS only" >&2
  exit 1
}

OUT_DIR="${1:-$BACKEND_ROOT/build/macos}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
VENV="$OUT_DIR/venv"
VENDOR="$OUT_DIR/vendor"
DIST="$OUT_DIR/dist"

VERSION="$(sed -n 's/^_DEFAULT_VERSION = "\(.*\)"$/\1/p' "$BACKEND_ROOT/app/version.py")"
[[ -n "$VERSION" ]] || { echo "[build] no _DEFAULT_VERSION in app/version.py" >&2; exit 1; }
ZIP="$DIST/subsmelt-whisper-macos-arm64-$VERSION.zip"
echo "[build] SubSmelt Whisper $VERSION -> $OUT_DIR"

# The Windows build's locked versions: the same backend, the same PyAV pin
# that keeps faster-whisper decoding (see packaging/windows/constraints.txt).
uv venv --allow-existing -p "$PYTHON_VERSION" "$VENV"
VIRTUAL_ENV="$VENV" uv pip install \
  -c "$BACKEND_ROOT/packaging/windows/constraints.txt" \
  -r "$BACKEND_ROOT/requirements.txt" pyinstaller

"$SCRIPT_DIR/fetch-vendor.sh" "$VENDOR"

(
  cd "$BACKEND_ROOT"
  SUBSMELT_MACOS_VENDOR="$VENDOR" "$VENV/bin/pyinstaller" "$SCRIPT_DIR/whisper-server.spec" \
    --clean --noconfirm --distpath "$DIST" --workpath "$OUT_DIR/pyinstaller"
)

# The menu-bar control app: a separate tiny bundle with pystray, Pillow, PyObjC
# and Tk, sharing no code path with the server bundle.
CONTROL_DIST="$OUT_DIR/dist-control"
CONTROL_VENV="$OUT_DIR/venv-control"
uv venv --allow-existing -p "$PYTHON_VERSION" "$CONTROL_VENV"
VIRTUAL_ENV="$CONTROL_VENV" uv pip install pyinstaller pystray pillow pyobjc
(
  cd "$BACKEND_ROOT"
  "$CONTROL_VENV/bin/pyinstaller" "$SCRIPT_DIR/whisper-control.spec" \
    --clean --noconfirm --distpath "$CONTROL_DIST" --workpath "$OUT_DIR/pyinstaller-control"
)

STAGE="$OUT_DIR/stage"
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE/$APP_FOLDER"
ditto "$DIST/whisper-server" "$STAGE/$APP_FOLDER/whisper-server"
ditto "$CONTROL_DIST/SubSmelt Whisper.app" "$STAGE/$APP_FOLDER/SubSmelt Whisper.app"
cp "$SCRIPT_DIR/install-launchd.sh" "$SCRIPT_DIR/uninstall-launchd.sh" \
  "$SCRIPT_DIR/com.subsmelt.whisper.plist.template" "$SCRIPT_DIR/README.md" \
  "$STAGE/$APP_FOLDER/"
ditto -c -k --keepParent "$STAGE/$APP_FOLDER" "$ZIP"

# Weights are .gguf (Nemotron, whisper.cpp), .safetensors or .bin (Whisper).
# nemo-speech's libggml-*.dylib runtime libraries are code, not weights.
if unzip -l "$ZIP" | grep -E '\.(gguf|safetensors|bin)$'; then
  echo "[build] model weights found in $ZIP" >&2
  exit 1
fi
echo "[build] $ZIP ($(du -h "$ZIP" | cut -f1))"
