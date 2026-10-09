#!/bin/bash
# Fill a vendor dir with the two native runtimes the macOS app bundles, and no
# model weights:
#
#   <vendor>/nemo-speech/{bin,lib,share}  NeMo-Speech.cpp (Metal) for Nemotron.
#                                          The binary loads its dylibs from
#                                          @loader_path/../lib, so bin and lib
#                                          stay siblings.
#   <vendor>/ffmpeg/{ffmpeg,ffprobe}       a minimal audio-only ffmpeg built
#                                          from source, linking only macOS
#                                          system libraries (LGPL; licence
#                                          files alongside).
#
# Usage: fetch-vendor.sh <vendor dir> [--force]
#
# Every download is SHA-256 verified. Each runtime keeps a marker
# (<vendor>/<name>.version) and is rebuilt when the pin below changes or
# --force is given. Set SUBSMELT_VENDOR_CACHE to a directory to keep and
# reuse the downloaded archives; cached archives are verified too.
set -euo pipefail

NEMO_SPEECH_VERSION="0.1.0" # matches NEMO_SPEECH_VERSION in backend-whisper/Dockerfile
NEMO_SPEECH_ARCHIVE="nemo-speech-${NEMO_SPEECH_VERSION}-macos-aarch64-metal.tar.gz"
NEMO_SPEECH_URL="https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${NEMO_SPEECH_VERSION}/${NEMO_SPEECH_ARCHIVE}"
NEMO_SPEECH_SHA256="f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244"

FFMPEG_VERSION="7.1.2" # the pin in the root Dockerfile
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_ARCHIVE}"
FFMPEG_SHA256="089bc60fb59d6aecc5d994ff530fd0dcb3ee39aa55867849a2bbc4e555f9c304"
# Audio extraction only: the demuxers for common video containers, the audio
# decoders anime and TV releases use, a WAV muxer and the filters app/ runs.
# shellcheck disable=SC2054 # the commas are configure's own list syntax
FFMPEG_CONFIGURE_FLAGS=(
  --disable-everything --disable-autodetect --disable-doc --disable-debug
  --enable-small --disable-ffplay --enable-ffmpeg --enable-ffprobe
  --enable-protocol=file,pipe
  --enable-demuxer=mov,matroska,avi,mpegts,flv,ogg,wav,aac,mp3,flac,ac3,eac3,dts,truehd,webm_dash_manifest
  --enable-muxer=wav,null
  --enable-decoder=aac,aac_latm,opus,vorbis,mp3,mp2,ac3,eac3,dca,flac,truehd,mlp,alac,pcm_s16le,pcm_s24le,pcm_f32le
  --enable-encoder=pcm_s16le
  --enable-parsers
  --enable-filter=aresample,aformat,anull,null,atrim,silencedetect,pan
)

usage() {
  echo "usage: $0 <vendor dir> [--force]" >&2
  exit 2
}

VENDOR_DIR=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -*) usage ;;
    *) [[ -z "$VENDOR_DIR" ]] || usage; VENDOR_DIR="$arg" ;;
  esac
done
[[ -n "$VENDOR_DIR" ]] || usage
mkdir -p "$VENDOR_DIR"
VENDOR_DIR="$(cd "$VENDOR_DIR" && pwd)"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/subsmelt-vendor.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { echo "[fetch-vendor] $*"; }

# Prints the path of a verified copy of <archive>, downloading it when the
# cache does not already hold one.
fetch_archive() {
  local archive="$1" url="$2" sha="$3"
  local dir="${SUBSMELT_VENDOR_CACHE:-$WORK_DIR}"
  mkdir -p "$dir"
  local path="$dir/$archive"
  if [[ ! -f "$path" ]]; then
    log "downloading $url" >&2
    curl -fL --retry 3 -o "$path.part" "$url"
    mv "$path.part" "$path"
  fi
  local actual
  actual="$(shasum -a 256 "$path" | cut -d' ' -f1)"
  if [[ "$actual" != "$sha" ]]; then
    rm -f "$path"
    echo "[fetch-vendor] SHA-256 mismatch for $archive: expected $sha, got $actual" >&2
    exit 1
  fi
  echo "$path"
}

# True when <name> is present and was built from the current pin.
is_current() {
  local name="$1" pin="$2"
  [[ "$FORCE" -eq 0 && -d "$VENDOR_DIR/$name" && -f "$VENDOR_DIR/$name.version" ]] &&
    [[ "$(cat "$VENDOR_DIR/$name.version")" == "$pin" ]]
}

# Moves a staged runtime into place, then records its pin.
install_runtime() {
  local name="$1" staged="$2" pin="$3"
  rm -rf "${VENDOR_DIR:?}/$name" "$VENDOR_DIR/$name.version"
  mv "$staged" "$VENDOR_DIR/$name"
  printf '%s' "$pin" >"$VENDOR_DIR/$name.version"
  log "$name ready ($(du -sh "$VENDOR_DIR/$name" | cut -f1))"
}

fetch_nemo_speech() {
  local pin="$NEMO_SPEECH_VERSION $NEMO_SPEECH_SHA256"
  if is_current nemo-speech "$pin"; then
    log "nemo-speech $NEMO_SPEECH_VERSION already present"
    return
  fi
  local archive
  archive="$(fetch_archive "$NEMO_SPEECH_ARCHIVE" "$NEMO_SPEECH_URL" "$NEMO_SPEECH_SHA256")"
  tar -xzf "$archive" -C "$WORK_DIR"
  local staged="$WORK_DIR/nemo-speech"
  [[ -x "$staged/bin/nemo-speech" ]] || { echo "[fetch-vendor] bin/nemo-speech missing from $NEMO_SPEECH_ARCHIVE" >&2; exit 1; }
  rm -rf "$staged/include" "$staged/lib/cmake" "$staged/lib/pkgconfig"
  "$staged/bin/nemo-speech" --version >/dev/null
  install_runtime nemo-speech "$staged" "$pin"
}

fetch_ffmpeg() {
  local pin="$FFMPEG_VERSION $FFMPEG_SHA256 ${FFMPEG_CONFIGURE_FLAGS[*]}"
  if is_current ffmpeg "$pin"; then
    log "ffmpeg $FFMPEG_VERSION already present"
    return
  fi
  local archive
  archive="$(fetch_archive "$FFMPEG_ARCHIVE" "$FFMPEG_URL" "$FFMPEG_SHA256")"
  tar -xJf "$archive" -C "$WORK_DIR"
  local src="$WORK_DIR/ffmpeg-$FFMPEG_VERSION"
  log "building ffmpeg $FFMPEG_VERSION"
  (
    cd "$src"
    ./configure "${FFMPEG_CONFIGURE_FLAGS[@]}" >"$WORK_DIR/ffmpeg-configure.log"
    make -j"$(sysctl -n hw.ncpu)" ffmpeg ffprobe >"$WORK_DIR/ffmpeg-make.log" 2>&1
  ) || { tail -40 "$WORK_DIR"/ffmpeg-*.log >&2; exit 1; }

  local staged="$WORK_DIR/ffmpeg-out"
  mkdir -p "$staged"
  cp "$src/ffmpeg" "$src/ffprobe" "$src/LICENSE.md" "$src/COPYING.LGPLv2.1" "$staged/"
  # Anything outside the OS would be missing on a Mac without Homebrew.
  local foreign
  foreign="$(otool -L "$staged/ffmpeg" "$staged/ffprobe" | awk 'NR > 1 && /^\t/ { print $1 }' |
    grep -Ev '^(/usr/lib/|/System/Library/)' || true)"
  if [[ -n "$foreign" ]]; then
    echo "[fetch-vendor] ffmpeg links libraries outside macOS: $foreign" >&2
    exit 1
  fi
  install_runtime ffmpeg "$staged" "$pin"
}

fetch_nemo_speech
fetch_ffmpeg
log "vendor dir: $VENDOR_DIR"
