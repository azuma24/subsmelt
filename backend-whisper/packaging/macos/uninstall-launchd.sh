#!/bin/bash
# Remove the SubSmelt Whisper launchd agent and app for the current user.
#
# Usage: uninstall-launchd.sh [--keep-config] [--skip-launchd]
#
#   --keep-config   leave config.json (and the token in it) for a reinstall
#   --skip-launchd  remove the files but leave launchctl alone
#
# Stops the agent, deletes its plist and ~/Applications/SubSmelt Whisper, and
# removes config.json and backend-info.txt. Models, media and logs are never
# touched.
set -euo pipefail

LABEL="com.subsmelt.whisper"
APP_DIR="$HOME/Applications/SubSmelt Whisper"
DATA_DIR="$HOME/Library/Application Support/SubSmelt"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

KEEP_CONFIG=0
SKIP_LAUNCHD=0
for arg in "$@"; do
  case "$arg" in
    --keep-config) KEEP_CONFIG=1 ;;
    --skip-launchd) SKIP_LAUNCHD=1 ;;
    *) sed -n '4,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
  esac
done

if [[ "$SKIP_LAUNCHD" -eq 0 ]]; then
  if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then
    echo "Stopped $LABEL."
  else
    echo "$LABEL was not loaded."
  fi
fi

remove() {
  if [[ -e "$1" ]]; then
    echo "Removing $1..."
    rm -rf "$1"
  fi
}

remove "$PLIST"
remove "$APP_DIR"
if [[ "$KEEP_CONFIG" -eq 0 ]]; then
  remove "$DATA_DIR/config.json"
  remove "$DATA_DIR/backend-info.txt"
fi
echo "Done. Models, media and logs were left in place."
