#!/bin/sh
# Optional privilege drop. Without PUID the container runs as root exactly as
# it always has, so volumes that earlier images filled with root-owned files
# keep working. With PUID (and optionally PGID, defaulting to PUID) it hands
# the data and config folders to that user and runs SubSmelt as them, which
# makes config.json (written 0600) and the database editable on the host.
# Media is never chowned: the host user must already be able to write there.
set -eu

# Keep node:22-slim's own entrypoint behaviour, which this script replaces:
# an option, an unknown command or a non-executable file (`--version`,
# `dist/server/index.js`) runs through node.
if [ "${1#-}" != "${1}" ] || [ -z "$(command -v "${1}")" ] || { [ -f "${1}" ] && ! [ -x "${1}" ]; }; then
  set -- node "$@"
fi

if [ -z "${PUID:-}" ]; then
  if [ -n "${PGID:-}" ]; then
    echo "subsmelt: PGID is set without PUID; ignoring it and running as root" >&2
  fi
  exec "$@"
fi

uid="$PUID"
gid="${PGID:-$PUID}"
case "$uid$gid" in
  *[!0-9]*) echo "subsmelt: PUID and PGID must be numeric (got PUID=$uid PGID=$gid)" >&2; exit 64 ;;
esac

if [ "$(id -u)" != "0" ]; then
  echo "subsmelt: PUID is set but the container is not running as root; starting as $(id -u)" >&2
  exec "$@"
fi

data_dir="${DATA_DIR:-/app/data}"
config_dir="${CONFIG_DIR:-/app/config}"
home_dir="/home/subsmelt"
mkdir -p "$data_dir" "$config_dir" "$home_dir"
# Only touch what is not already owned by the target, so restarts stay fast on
# large data folders.
for dir in "$data_dir" "$config_dir" "$home_dir"; do
  find "$dir" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown -h "$uid:$gid" {} +
done

# yt-dlp keeps its cache under $HOME; root's home is not writable by the user.
export HOME="$home_dir"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
