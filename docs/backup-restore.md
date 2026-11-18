# Back up and restore SubSmelt state

Stop SubSmelt before taking a backup. The command acquires the same state-directory locks as the server and refuses to run while those directories are owned. Stop any other installation writing translation progress in the same media library too.

Build a source checkout once with `npm run build`. The Docker image already includes the compiled server and this command. `node scripts/state-backup.mjs --help` works without a build.

## Create a backup

```sh
mkdir -p /backups
npm run backup -- --output /backups/subsmelt-2026-11-18 \
  --data-dir /srv/subsmelt/data \
  --config-dir /srv/subsmelt/config \
  --media-dir /srv/media
```

The destination must not exist and must be outside the state and media directories. Backup flags override `DATA_DIR`, `CONFIG_DIR`, `MEDIA_DIR` and `CONVERT_BATCH_DIR`. Without flags, the normal application defaults apply. Include `--convert-batch-dir /srv/subsmelt/batches` when batch work uses an external directory that is not already selected by the environment.

For Docker Compose, stop the application service and run the command in a one-off container with the same state/media mounts and an additional writable backup mount. The equivalent command inside the image is `node scripts/state-backup.mjs backup --output /backups/subsmelt-2026-11-18`. Do not run the backup through a still-running application container.

The output is a directory bundle. `manifest.json` records its format version, creation time, original roots, file sizes, owner permissions, and SHA-256 checksums. Keep the whole directory together. It includes:

- A consistent SQLite snapshot, including committed changes that were still in the source WAL.
- Files under the data and configuration directories, including queue markers, transcription history, review/work state and saved URL transcription artifacts.
- The configured conversion-batch directory, including external batch storage.
- Existing `.part` and `.part.json` translation resume files associated with database jobs under `MEDIA_DIR`.

It excludes ownership lock files and SQLite WAL/shared-memory files. It does not copy the media library, source subtitles, finished translated subtitles, external YouTube notes, external model caches, or environment/mounted-secret values. Back up those separately where needed. The bundle includes credentials saved in configuration and may contain subtitle text. Store it with the same access restrictions as the original state. Restored files use owner-only permissions, preserving owner execution for saved tools such as `data/bin/yt-dlp`.

Symlinks inside captured state or resume paths are rejected instead of followed. If a database job has a resume file outside `MEDIA_DIR`, backup fails with that path so it cannot silently omit saved progress.

## Restore a backup

Choose empty data and configuration destinations. The media directory may already contain the original library.

```sh
npm run restore -- --input /backups/subsmelt-2026-11-18 \
  --data-dir /srv/subsmelt-restored/data \
  --config-dir /srv/subsmelt-restored/config \
  --media-dir /srv/media
```

All four flags above are required. Restore never falls back to live data or configuration directories from the environment. Conversion batches default to the new data directory's `convert-batches` subdirectory. Use `--convert-batch-dir /srv/subsmelt-restored/batches` to restore them to a separate empty directory. Restore ignores an inherited `CONVERT_BATCH_DIR` unless the flag is supplied.

Restore checks the manifest, checksums, database integrity, configuration and all target paths before copying state. Data, configuration and external batch destinations must be empty, apart from permanent ownership lock files left by an earlier attempt. They must be separate directories; batches may be inside data. Existing media files are retained. Every backed-up resume-file destination must be absent. Existing resume files cause an error before state is copied, even when their contents match. Each copy also uses exclusive creation, so a file appearing after that check is never overwritten.

If the media library moved, supply its new root with `--media-dir`. Restore maps database job paths, output claims, persisted transcription paths, and matching local directory settings from the recorded roots to the selected destinations. Existing media root spelling is preserved when the same root is supplied. Resume keys depend on source contents and translation settings, so keep the original source subtitles and settings to reuse saved cues. Remote backend path mappings and external notes paths that lie outside the recorded roots remain unchanged; adjust them in Settings if that deployment changed.

After successful restore, start SubSmelt with the selected `DATA_DIR`, `CONFIG_DIR`, `MEDIA_DIR` and, if external, `CONVERT_BATCH_DIR`. On its first owned startup, interrupted translations return to pending and interrupted transcription attempts are reconciled. The saved resume sidecars remain available. Normal queue auto-resume settings still apply. Make the original media available before starting the server if you chose a new media root.

An I/O error or a new destination-file conflict during copying can leave a partial restore. The command reports failure and does not start the app. Preserve those files for inspection and retry with fresh empty state destinations after resolving the cause.

## State-directory ownership

The server claims the canonical data, configuration and conversion-batch directories before importing modules that load, migrate or recover state. A second process cannot use any of those directories, even through symlink aliases or on another HTTP port. Separate state directories remain independent, and shared or read-only media mounts remain supported.

Each owned directory contains a permanent `.subsmelt-owner.sqlite` file. An exclusive SQLite rollback-journal transaction holds the operating-system lock for the process lifetime. A crash or `SIGKILL` releases it automatically. There is no PID lease to expire or stale PID file to delete. Never remove a lock file while a process may own it. These directories require a filesystem with reliable SQLite locking; keep application state on local storage or a volume that supports SQLite's locking semantics.
