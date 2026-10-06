import fs from "node:fs";
import path from "node:path";

/**
 * Permissions for what the server writes into media and notes folders.
 *
 * The container runs as root, so with the default umask its subtitles,
 * transcripts, downloads and notes came out 644 (folders 755), owned by root:
 * read-only to the person editing them from another computer over a share.
 * Only these outputs are opened up; app state (database, config, cookies,
 * logs) keeps the default permissions.
 */
const SHARED_FILE_MODE = 0o666;
const SHARED_DIR_MODE = 0o777;

/** Best-effort: some network filesystems ignore chmod. */
export function shareFile(file: string): void {
  try {
    fs.chmodSync(file, SHARED_FILE_MODE);
  } catch {}
}

/** mkdir -p that opens up only the folders it creates, not existing parents. */
export function mkdirShared(dir: string): void {
  const firstCreated = fs.mkdirSync(dir, { recursive: true });
  if (!firstCreated) return;
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    try {
      fs.chmodSync(current, SHARED_DIR_MODE);
    } catch {}
    if (current === path.resolve(firstCreated) || current === path.dirname(current)) break;
  }
}
