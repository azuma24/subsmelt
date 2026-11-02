#!/usr/bin/env bash
# Proves the YouTube runtime inside the SubSmelt image: yt-dlp runs, ffmpeg
# runs, and a public playlist lists. Operator-run; the playlist argument goes
# straight to yt-dlp.
#
#   docker exec subsmelt scripts/youtube-smoke.sh
#   docker exec subsmelt scripts/youtube-smoke.sh 'https://www.youtube.com/playlist?list=PL...' --playlist-end 3
#
# Extra arguments after the playlist are passed to yt-dlp unchanged.
set -euo pipefail

DEFAULT_PLAYLIST="https://www.youtube.com/playlist?list=UUsooa4yRKGN_zEE8iknghZA"   # TED-Ed uploads
PLAYLIST="${1:-$DEFAULT_PLAYLIST}"
[ "$#" -gt 0 ] && shift
YTDLP="${SUBSMELT_YTDLP_BIN:-yt-dlp}"

echo "yt-dlp: $("$YTDLP" --version) ($(command -v "$YTDLP"))"
echo "ffmpeg: $(ffmpeg -version | head -1)"
echo "ffprobe: $(ffprobe -version | head -1)"

"$YTDLP" --js-runtimes node --no-warnings -J --flat-playlist "$@" "$PLAYLIST" | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const listing = JSON.parse(raw);
    const entries = listing.entries || [];
    console.log(`playlist: ${listing.title} (${listing.id}), availability ${listing.availability}, playlist_count ${listing.playlist_count}, listed ${entries.length}`);
    for (const entry of entries.slice(0, 3)) console.log(`  ${entry.id}  ${entry.duration ?? "?"}s  ${entry.title}`);
    if (entries.length === 0) { console.error("smoke: the listing has no entries"); process.exit(1); }
  });
'
