#!/bin/bash
# Install the SubSmelt Whisper backend as a launchd agent for the current user.
#
# Usage: install-launchd.sh [unzipped dir] [--port N] [--media-root PATH]
#                           [--model-dir PATH] [--skip-launchd] [--dry-run]
#
#   unzipped dir    the "SubSmelt Whisper" folder from the zip (default: the
#                   folder this script is in)
#   --port          TCP port (default: the configured one, else 8001)
#   --media-root    folder the backend may read media from (default: the
#                   configured one, else <data dir>/media)
#   --model-dir     model cache (default: the configured one, else
#                   <data dir>/models)
#   --skip-launchd  install the app, config.json and the plist, but leave
#                   launchctl alone
#   --dry-run       render config.json, the plist and backend-info.txt into
#                   $HOME (override HOME to preview) and touch nothing else:
#                   no app copy, no launchctl call
#
# Settings go to ~/Library/Application Support/SubSmelt/config.json (mode
# 0600), which the backend reads on every start. The plist carries only the
# program path: an environment variable there would override config.json.
# An existing token is kept; one is minted only when none is stored.
set -euo pipefail

LABEL="com.subsmelt.whisper"
DEFAULT_PORT=8001
HEALTH_TIMEOUT_S=90

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/Applications/SubSmelt Whisper"
PROGRAM="$APP_DIR/whisper-server/whisper-server"
DATA_DIR="$HOME/Library/Application Support/SubSmelt"
CONFIG="$DATA_DIR/config.json"
INFO_FILE="$DATA_DIR/backend-info.txt"
LOG_DIR="$HOME/Library/Logs/SubSmelt Whisper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

usage() {
  sed -n '4,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

SOURCE_DIR=""
PORT=""
MEDIA_ROOT=""
MODEL_DIR=""
SKIP_LAUNCHD=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) [[ $# -ge 2 ]] || usage; PORT="$2"; shift 2 ;;
    --media-root) [[ $# -ge 2 ]] || usage; MEDIA_ROOT="$2"; shift 2 ;;
    --model-dir) [[ $# -ge 2 ]] || usage; MODEL_DIR="$2"; shift 2 ;;
    --skip-launchd) SKIP_LAUNCHD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) [[ -z "$SOURCE_DIR" ]] || usage; SOURCE_DIR="$1"; shift ;;
  esac
done
# A dry run renders the files into $HOME (override HOME to preview); it never
# runs launchctl or copies the app.
if [[ "$DRY_RUN" -eq 1 ]]; then
  SKIP_LAUNCHD=1
fi
SOURCE_DIR="$(cd "${SOURCE_DIR:-$SCRIPT_DIR}" && pwd)"
[[ -x "$SOURCE_DIR/whisper-server/whisper-server" ]] || {
  echo "whisper-server/whisper-server not found in $SOURCE_DIR. Pass the unzipped \"SubSmelt Whisper\" folder." >&2
  exit 1
}

# Prints a key's value from config.json, or nothing. Only a successful
# extract counts: on some macOS versions plutil reports a missing key on
# stdout, which would otherwise read as a stored value.
config_value() {
  [[ -f "$CONFIG" ]] || return 0
  local value
  value="$(plutil -extract "$1" raw -o - "$CONFIG" 2>/dev/null)" || return 0
  printf '%s' "$value"
}

umask 077

if [[ "$SKIP_LAUNCHD" -eq 0 ]]; then
  # Stop a running copy before its files are replaced.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi

# --- App -------------------------------------------------------------------------
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run: the app itself is not copied."
elif [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  echo "Copying the app to $APP_DIR..."
  rm -rf "$APP_DIR/whisper-server"
  mkdir -p "$APP_DIR"
  ditto "$SOURCE_DIR/whisper-server" "$APP_DIR/whisper-server"
  if [[ -d "$SOURCE_DIR/SubSmelt Whisper.app" ]]; then
    rm -rf "$APP_DIR/SubSmelt Whisper.app"
    ditto "$SOURCE_DIR/SubSmelt Whisper.app" "$APP_DIR/SubSmelt Whisper.app"
  fi
  for file in install-launchd.sh uninstall-launchd.sh "$LABEL.plist.template" README.md; do
    [[ -f "$SCRIPT_DIR/$file" ]] && cp "$SCRIPT_DIR/$file" "$APP_DIR/"
  done
fi
# A browser-downloaded zip marks every file as quarantined, and Gatekeeper
# then refuses to let launchd start the unsigned binary.
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true

# --- config.json -------------------------------------------------------------------
PORT="${PORT:-$(config_value port)}"
PORT="${PORT:-$DEFAULT_PORT}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi
MEDIA_ROOT="${MEDIA_ROOT:-$(config_value media_root)}"
MEDIA_ROOT="${MEDIA_ROOT:-$DATA_DIR/media}"
MODEL_DIR="${MODEL_DIR:-$(config_value model_dir)}"
MODEL_DIR="${MODEL_DIR:-$DATA_DIR/models}"
mkdir -p "$DATA_DIR" "$LOG_DIR" "$MEDIA_ROOT" "$MODEL_DIR" "$(dirname "$PLIST")"

echo "Writing $CONFIG..."
staged_config="$CONFIG.tmp"
seed_config() { printf '{"port": %s}\n' "$PORT" >"$staged_config"; }
if [[ -f "$CONFIG" ]]; then cp "$CONFIG" "$staged_config"; else seed_config; fi
if ! plutil -replace port -integer "$PORT" "$staged_config" 2>/dev/null; then
  echo "WARNING: could not parse $CONFIG. Starting from an empty config." >&2
  seed_config
fi
plutil -replace media_root -string "$MEDIA_ROOT" "$staged_config"
plutil -replace model_dir -string "$MODEL_DIR" "$staged_config"
# The app finds its bundled ffmpeg and nemo-speech itself; a path left by an
# older install would override them.
plutil -remove ffmpeg "$staged_config" 2>/dev/null || true
plutil -remove nemo_speech "$staged_config" 2>/dev/null || true
chmod 600 "$staged_config"
mv "$staged_config" "$CONFIG"

if [[ -n "$(config_value token)" ]]; then
  echo "Keeping the existing token."
else
  # A dry run skips the app copy, so mint the token with the source program.
  TOKEN_PROGRAM="$PROGRAM"
  [[ "$DRY_RUN" -eq 1 ]] && TOKEN_PROGRAM="$SOURCE_DIR/whisper-server/whisper-server"
  env -u SUBSMELT_WHISPER_TOKEN SUBSMELT_WHISPER_CONFIG="$CONFIG" "$TOKEN_PROGRAM" --generate-token --save >/dev/null
  [[ -n "$(config_value token)" ]] || {
    echo "Could not store a token in $CONFIG." >&2
    exit 1
  }
  echo "Generated a new token."
fi
chmod 600 "$CONFIG"

# --- launchd agent ---------------------------------------------------------------
echo "Writing $PLIST..."
staged_plist="$PLIST.tmp"
cp "$SCRIPT_DIR/$LABEL.plist.template" "$staged_plist"
plutil -remove ProgramArguments.0 "$staged_plist"
plutil -insert ProgramArguments.0 -string "$PROGRAM" "$staged_plist"
plutil -replace StandardOutPath -string "$LOG_DIR/stdout.log" "$staged_plist"
plutil -replace StandardErrorPath -string "$LOG_DIR/stderr.log" "$staged_plist"
plutil -lint -s "$staged_plist"
chmod 644 "$staged_plist"
mv "$staged_plist" "$PLIST"

# --- Connection details --------------------------------------------------------------
BACKEND_URL="http://$(scutil --get LocalHostName 2>/dev/null || hostname -s).local:$PORT"
{
  echo "SubSmelt Whisper Backend"
  echo
  echo "Backend URL:   $BACKEND_URL"
  echo "Health check:  $BACKEND_URL/health"
  echo "Backend token: $(config_value token)"
  echo
  echo "Paste the URL and token into SubSmelt -> Settings -> Speech to Text."
  echo
  echo "Settings: $CONFIG"
  echo "Models:   $MODEL_DIR"
  echo "Media:    $MEDIA_ROOT"
  echo "Logs:     $LOG_DIR"
} >"$INFO_FILE"
chmod 600 "$INFO_FILE"

if [[ "$SKIP_LAUNCHD" -eq 1 ]]; then
  echo "Skipped launchctl. Load the agent with: launchctl bootstrap $DOMAIN \"$PLIST\""
  echo "Connection details written to $INFO_FILE."
  exit 0
fi

echo "Starting $LABEL..."
launchctl bootstrap "$DOMAIN" "$PLIST"

# --- Menu-bar app --------------------------------------------------------------
CONTROL_APP="$APP_DIR/SubSmelt Whisper.app"
if [[ -d "$CONTROL_APP" ]] && [[ -t 0 ]]; then
  read -r -p "Add the SubSmelt Whisper menu-bar app to Login Items? [y/N] " answer || answer=""
  if [[ "$answer" =~ ^[Yy] ]]; then
    if osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$CONTROL_APP\", hidden:true}" >/dev/null 2>&1; then
      echo "Added to Login Items."
    else
      echo "Could not add the Login Item; add \"$CONTROL_APP\" in System Settings > Login Items."
    fi
  fi
elif [[ -d "$CONTROL_APP" ]]; then
  echo "Menu-bar app installed at $CONTROL_APP (add it to Login Items to start it at login)."
fi

health_url="http://127.0.0.1:$PORT/health"
for ((i = 0; i < HEALTH_TIMEOUT_S; i++)); do
  if curl -sf -o /dev/null --max-time 2 "$health_url"; then
    echo "The backend is answering on port $PORT."
    echo "Connection details written to $INFO_FILE."
    exit 0
  fi
  sleep 1
done
echo "WARNING: $health_url did not answer within ${HEALTH_TIMEOUT_S} s. Check $LOG_DIR." >&2
echo "Connection details written to $INFO_FILE."
