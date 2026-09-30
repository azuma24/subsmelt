# PRD: YouTube playlists (follow, download, transcribe, translate, export notes)

Status: draft for review · Owner: azuma24 · Date: 2026-09-30
Branch: `feat/youtube-playlists`

## 1. Problem

The user keeps YouTube playlists of videos they want to watch or have watched. They want the spoken content of those videos as text they can search and reuse later in a second brain (an Obsidian-style vault now, a custom "myfeed" app later). Today that takes four tools: a downloader, a transcriber, a translator and a note writer. SubSmelt already does the middle two. It has no way to follow a playlist, keep a record of its videos, download them, or write a note per video.

## 2. Goals

- **G1. Follow a playlist without a YouTube login.** The user pastes the URL of an Unlisted playlist. A cookies file is the fallback for Private playlists.
- **G2. Keep a record of every video.** One row per video, one status, visible in a new YouTube tab. The record survives restarts and reappears after the data folder is wiped.
- **G3. Download video or audio.** Per playlist, the user picks video (maximum height, preferred codec, container) or audio (format).
- **G4. Automatic or manual.** Per playlist, new videos either download on their own or wait for the user to click Download.
- **G5. Subtitles without waste.** Use the creator's captions when they exist in the video's language. Otherwise transcribe with the Whisper backend.
- **G6. Translate with the existing queue.** The user picks target languages per playlist from the existing translation tasks.
- **G7. One Markdown note per video.** Frontmatter with the metadata, chapters, the transcript in timestamped paragraphs that link back to YouTube, and one section per translation.
- **G8. Share one GPU.** Whisper and the local translation LLM run on the same GPU. When the user says so, transcription and translation never run at the same time, and pending transcriptions finish before translation starts.

## 3. Non-goals

- Google OAuth, and Watch Later or Liked videos through the API. (Watch Later is not readable through the API at all.) The Data API is used only with an optional API key, only to read added dates.
- Channels as a source type. A channel's uploads playlist (`UU...` list ID) already works as a playlist.
- Deleting files when a video leaves a playlist. Rows are marked "removed at source". Files stay.
- Deleting media after transcription, per-playlist retention, quality upgrades later.
- SponsorBlock, thumbnails on disk, NFO files, Plex or Jellyfin integration.
- The PO token provider sidecar (bgutil). Add it only if 403s or missing formats show the need.
- Automatic transcription of ordinary library videos. The YouTube worker drives transcription for its own videos only.
- A GPU lock for manual transcriptions started from the Dashboard. The user starts those on purpose.

## 4. Decisions

### Locked by the user

| # | Decision | Value |
|---|----------|-------|
| U1 | Login | None. Unlisted URL; cookies.txt only for Private playlists. |
| U2 | Where it lives | Inside SubSmelt. One app. No MeTube or TubeSync sidecar. |
| U3 | TubeSync | Learn its ideas. Copy no code. TubeSync is AGPL-3.0 and SubSmelt is MIT. |
| U4 | Media type | Video or audio, chosen per playlist. |
| U5 | Languages | Chosen by the user. |
| U6 | Notes | Obsidian-style Markdown, written to a separate `/notes` mount that points at the vault. |
| U7 | Translations in the note | One note per video, one section per language. |
| U8 | GPU | Whisper and the LLM share one GPU. Batch: transcribe everything pending, then translate. |
| U9 | Subtitle languages | The user picks the languages they want subtitles in, per playlist. Videos arrive in many spoken languages, so nothing assumes English. SubSmelt gets each picked language by the cheapest route: the transcript itself, the creator's captions, or a translation (D6). |
| U10 | Removal | Keep files, mark the video "removed" (D7). |
| U11 | Shipping yt-dlp and ffmpeg | In the main image (D3). |
| U12 | Delivery | Prototypes first, then one PR at a time, each reviewed and merged before the next. |
| U13 | Obsidian links | Channel and playlist as wikilinks in the frontmatter. |
| U14 | Length filters | None. The user skips videos by hand. |
| U15 | Notifications | A webhook event when a note is ready, through the existing webhook setting. |
| U17 | Backfill dates | A year and month picker, not a fixed list. Any month up to the current one. |
| U18 | API key | Entered in Settings, YouTube section, with a Test button and setup steps. |
| U16 | Exposure | SubSmelt is reachable on the home network only. No login is added for this feature. |

### Engineering decisions

| # | Decision | Value | Why |
|---|----------|-------|-----|
| D1 | Playlist settings storage | JSON in settings key `youtube_playlists` in `config.json` | `config/` is the folder users keep; `data/` is documented as safe to wipe (`docker-compose.yml:16-19`). Same pattern as `directory_rules`. |
| D2 | Video records storage | SQLite tables in `data/subsmelt.db` | Rebuildable from the playlist listing plus the files on disk. |
| D3 | Where yt-dlp runs | Main container. Standalone yt-dlp binary plus ffmpeg added to the image. | Files must land in SubSmelt's `/media`. The Whisper backend is optional and can be remote without a shared mount. |
| D4 | JavaScript runtime for yt-dlp | The image's own Node (`--js-runtimes node`) | No Deno download. Official yt-dlp builds bundle the `yt-dlp-ejs` scripts. |
| D5 | Format choice | yt-dlp format sorting (`-S`), not a custom matcher | Replaces TubeSync's 500-line `matching.py` with one argument. |
| D6 | Subtitle languages | `subtitleTaskIds` on the playlist, chosen from the existing Translations tasks. The YouTube worker creates exactly the jobs each video needs, and the scanner skips the YouTube download folder. | One owner per folder. A library scan cannot add translations the playlist did not ask for, and no full-library scan runs per video. |
| D7 | Removal | Mark `removed_at`, never delete files | Makes a bad listing harmless. |
| D8 | Cookies location | `${DATA_DIR}/youtube/cookies.txt`, mode 0600, never returned by the API | Keeps a full Google session out of the version-controlled `config/` folder. |

## 5. Domain model

### Playlist (settings key `youtube_playlists`)

```ts
interface YoutubePlaylist {
  id: string;               // YouTube list ID, validated /^[A-Za-z0-9_-]{10,64}$/
  title: string;            // cached from the last sync
  folder: string;           // under the YouTube download folder, via normalizeMediaSubfolder
  enabled: boolean;
  mode: "auto" | "manual";
  backfill:                  // which videos already in the playlist to download when it is followed
    | { kind: "all" }
    | { kind: "none" }
    | { kind: "posted_since"; date: string }  // YYYY-MM-DD, no key needed
    | { kind: "added_since"; date: string };  // YYYY-MM-DD, needs youtube_api_key
  media:
    | { type: "video"; maxHeight: 480 | 720 | 1080 | 1440 | 2160; codec: "h264" | "vp9" | "av1" | "any"; container: "mp4" | "mkv" }
    | { type: "audio"; format: "m4a" | "opus" };
  captions: "prefer_youtube" | "whisper_only";
  subtitleTaskIds: number[]; // Translations tasks whose target languages this playlist wants
  checkEveryMinutes: number; // minimum 15, default 60; plus a "Check now" button
}
```

The discriminated `media` union makes "audio with a codec" and "video with an audio format" unrepresentable.

### Video (SQLite)

```sql
CREATE TABLE IF NOT EXISTS youtube_videos (
  video_id      TEXT PRIMARY KEY,   -- /^[A-Za-z0-9_-]{11}$/
  playlist_id   TEXT NOT NULL,      -- owning playlist: its media settings and folder apply
  title         TEXT NOT NULL,
  channel       TEXT,
  duration_s    INTEGER,
  published_at  TEXT,               -- exact once metadata is fetched; approximate from the listing before that
  added_at      TEXT,               -- date added to the playlist; known only with a YouTube API key
  status        TEXT NOT NULL,
  skip_kind     TEXT,               -- "user" | "before_start" | "members_only"; set only when skipped
  reason        TEXT,               -- why skipped, waiting or failed; shown in the UI
  attempts      INTEGER NOT NULL DEFAULT 0,
  retry_after   TEXT,
  media_path    TEXT,               -- relative to MEDIA_DIR
  subtitle_path TEXT,
  note_path     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS youtube_playlist_items (
  playlist_id   TEXT NOT NULL,
  video_id      TEXT NOT NULL REFERENCES youtube_videos(video_id),
  position      INTEGER,
  first_seen_at TEXT NOT NULL,
  removed_at    TEXT,
  PRIMARY KEY (playlist_id, video_id)
);
CREATE TABLE IF NOT EXISTS youtube_sync_state (
  key   TEXT PRIMARY KEY,  -- "playlist:<id>" or "cooldown"
  value TEXT NOT NULL      -- JSON: lastCheckedAt, lastError, count / until, cause
);
```

A video is one entity. Playlists are memberships. Moving a video from a "to watch" playlist to a "watched" playlist keeps one row and one set of files.

### Video status

One status column replaces TubeSync's four booleans (`downloaded`, `skip`, `manual_skip`, `can_download`). Allowed transitions live in one table in `src/server/youtube/video-status.ts`. The store refuses any other transition.

| Status | Meaning | Leaves to |
|--------|---------|-----------|
| `new` | Listed, waiting for the user (manual mode) | `queued`, `skipped` |
| `queued` | Will download when the lane is free | `downloading`, `skipped` |
| `downloading` | yt-dlp is running | `transcribing`, `queued` (retry), `waiting`, `unavailable`, `failed` |
| `transcribing` | Fetching creator captions or running Whisper | `translating`, `transcribing` (retry), `failed` |
| `translating` | Subtitle written; translation jobs pending | `done` |
| `done` | Subtitle, translations and note written | `queued` (redo) |
| `waiting` | Premiere or live stream not finished; `retry_after` set | `queued` |
| `skipped` | User skipped, members-only, or left out by the backfill filter (`skip_kind` says which). A tombstone: sync never revives it. | `queued` |
| `unavailable` | Private or deleted on YouTube | `queued` |
| `failed` | Retries used up; `reason` says why | `queued` |

The client mirrors the user actions per status (Download, Skip, Retry) in a small pure map with its own test.

## 6. Pipeline

One in-process worker (`src/server/youtube/worker.ts`) ticks every 30 seconds and on demand. It has two lanes.

**YouTube lane (serial).** Every yt-dlp call that reaches YouTube goes through it: listing, captions and downloads. Before each call it checks the stored cooldown. A rate-limit or bot-check error sets `cooldown` to now plus 1 hour, doubling per repeat up to 24 hours, and broadcasts `youtube:cooldown`. TubeSync never added this and users had their IPs banned for weeks (TubeSync #1529, #1377).

**Transcription lane.** Calls the existing `runTranscriptionAttempt` (`routes/transcription-runtime.ts`), which already owns the concurrency limit, history and cancellation.

### Steps

1. **Sync.** For each enabled playlist whose check is due, run `yt-dlp -J --flat-playlist` on the canonical URL `https://www.youtube.com/playlist?list=<id>`. Upsert every entry. New videos become `queued` (auto) or `new` (manual). On the first sync, videos outside the backfill choice become `skipped` with `skip_kind` `before_start` (see "Backfill filter"). Mark missing entries `removed_at` only when the listing is non-empty and its entry count equals YouTube's reported `playlist_count`. An entry that reappears clears `removed_at`. An entry with no title and no duration is a private or deleted video. It is stored as `unavailable`, never dropped, because YouTube still counts it in `playlist_count`.
2. **Download.** Claim the next `queued` video. Videos found after the follow go first, newest first. Backfill videos follow in playlist order. yt-dlp works in `${DATA_DIR}/youtube/tmp/<video_id>` and moves the finished file into the playlist folder. It writes `<stem>.info.json` next to the file. Progress goes out as `youtube:video` events.
3. **Subtitle.** With `prefer_youtube`, read `language` and `subtitles` from the info JSON. If a creator caption exists in the video's language, fetch it with `--skip-download --write-subs --convert-subs srt`. Otherwise, or with `whisper_only`, transcribe the file. The subtitle is named `<stem>.<lang>.srt` or `<stem>.srt`, matching the transcription naming rule (`transcription/request.ts:179-183`).
4. **Subtitle languages.** The spoken language S comes from the info JSON `language`, or from transcription when that is missing. The transcript in S is always written as `<stem>.<S>.srt`; notes and translations start from it. Then, for each picked task T with target language L, the first route that applies wins, and every result is written under T's own output name (its pattern, for example `{{name}}.chi.srt`):
   - **Same language** (L equals S after code normalisation): the transcript is the subtitle. Copy it to T's output name. No LLM call.
   - **Creator captions** exist in L (manual captions only, never YouTube's auto-translated ones): download them with `--skip-download --write-subs --sub-langs <L> --convert-subs srt` through the YouTube lane.
   - **Otherwise:** create a translation job directly (`createJob` with the transcript as `srt_path` and task T), then start the queue through the GPU gate.
   The scanner skips the YouTube download folder entirely, so a library scan never adds jobs the playlist did not ask for.
5. **Finish.** When no translation job for the subtitle is `pending` or `translating`, write the note and set `done`. A translation error does not block `done`. The Jobs page already shows it.

### Backfill filter

When the user follows a playlist, they choose which of the videos already in it to download. Videos added afterwards are always included, whatever their dates. Adding a video to the playlist is the signal.

| Choice | Needs | How it is decided |
|--------|-------|-------------------|
| All | Nothing | Every listed video |
| Only new | Nothing | None of the listed videos |
| Posted since a date | Nothing | yt-dlp. The flat listing gives an approximate publish date that YouTube rounds ("2 months ago"). Videos whose rounded date is within one rounding step of the cutoff get an exact `upload_date` from a per-video metadata call through the YouTube lane. The rest are decided from the listing. |
| Added since a date | A YouTube Data API key | `playlistItems.list` with the key returns `snippet.publishedAt`, "the date and time that the item was added to the playlist". One request covers 50 videos, so 889 videos take 18 requests out of the default 10,000 daily quota units. |

- **The API key is not a login.** The user creates it in Google Cloud Console with the YouTube Data API v3 enabled, and ideally restricts it to that API. It goes in `youtube_api_key`, a secret setting that GET /api/settings redacts. Without a key, "Added since" is disabled with a hint that links to Settings.
- **yt-dlp still lists the playlist.** The API is called only to read added dates: at follow time, and at each sync to fill `added_at` for new videos. If the API call fails, sync continues without added dates.
- **The month is picked, not preset.** A year and month picker (year arrows, 12 month buttons) shows how many videos were posted in each month and disables months after the current one. The chosen month's first day is the cutoff.
- **The dialog shows the size first.** Picking a choice shows videos, hours and estimated disk use for the chosen profile. For "Posted since", the preview counts from approximate dates and says "about".
- **The filter applies once, at the first sync.** Videos it leaves out become `skipped` with `skip_kind` `before_start`. "Change filter" on the playlist page re-runs a new choice. It touches only `before_start` rows, never the user's own skips. The user can still download any skipped video by hand.
- `added_at` also goes into the note frontmatter when known.

### Sharing one GPU (setting `gpu_shared`)

The setting lives in Settings, Speech-to-text: "Transcription and translation share one GPU". Off by default. When on, one gate in `src/server/gpu-gate.ts` decides who may use the GPU.

- **Translation may start** only when no transcription is running and no YouTube video is `queued`, `downloading` or `transcribing`. One exception caps the wait. When 20 subtitles are waiting for translation, the gate opens after the current transcription even if more videos are pending. Without the cap, a large backfill would hold every translation for days (Appendix B, P4). `processQueue()` asks the gate first, whoever triggered it (the YouTube worker, the watcher, auto-scan, or the Run button). A held start is retried when the gate opens.
- **Transcription may start** only when the translation queue is idle. A translation batch already running finishes first. It is never aborted.
- **Cooldown releases the hold.** While YouTube downloads are paused by a cooldown, `queued` videos do not hold translation.
- The YouTube page shows the held state: "Translation waits for 3 transcriptions to finish."

The effect is batches. Every pending video downloads and transcribes, then the whole set translates, then the next set starts. The model swaps twice per batch instead of twice per video. The cost is that the first translation arrives after the last transcription of the batch.

### Crash safety

Every step checks disk for its own output before doing work, so running a step twice converges to the same state.

- At boot, delete `${DATA_DIR}/youtube/tmp/*`. TubeSync's stale temp files caused HTTP 416 errors on resume (#1579).
- At boot, `downloading` goes back to `queued`, and `transcribing` goes to `translating` if its subtitle exists.
- A `queued` video whose media file already exists skips straight to the subtitle step.
- After a data-folder wipe, the next sync recreates the rows, and the file checks above restore their statuses.
- Each yt-dlp child gets a hard timeout: 10 minutes for a listing, and for a download the larger of 1 hour and twice the video's duration. A timeout is an ordinary retryable failure.
- Whisper gets the larger of the `transcription_timeout` setting (30 minutes by default) and the video's duration. The user's test playlist has 63 videos over an hour and one of 7.4 hours.
- Retryable failures back off 10 minutes, 1 hour, then 6 hours. The fourth failure sets `failed`.

## 7. yt-dlp

### Install

- The Dockerfile downloads the pinned standalone binary per `TARGETARCH` (`yt-dlp_linux` or `yt-dlp_linux_aarch64`) and checks its SHA-256.
- ffmpeg and ffprobe are built from source in a Docker build stage with only the pieces yt-dlp needs: file and pipe protocols; mp4, Matroska, Ogg and subtitle containers; stream copy; the native AAC encoder; WebVTT to SRT. Prototype P3 measured the options (Appendix B). The minimal build adds 7 MB and compiles in about 20 seconds. Debian's package adds 390 MB and the static release build adds 250 MB.
- No MP3 output. MP3 needs the external LAME library. YouTube never serves MP3, so it would always mean re-encoding.
- Updates. The wrapper prefers `${DATA_DIR}/bin/yt-dlp` when it exists. "Update yt-dlp" in Settings copies the image binary there if it is missing, then runs `yt-dlp -U`. A daily automatic check is on by default while any playlist is followed. YouTube breaks old yt-dlp releases within weeks.
- License. The PyInstaller builds are GPLv3+. SubSmelt runs yt-dlp as a separate program and does not link it. Ship its license text in the image.

### Arguments

All calls use `spawn` with an argument array, never a shell. User text never reaches yt-dlp. The server builds each URL from a validated ID.

Common arguments:

```
--js-runtimes node --no-playlist --newline --progress-template <json>
--paths temp:<tmp dir> --paths home:<playlist folder>
-o "%(title).120B [%(id)s].%(ext)s" --windows-filenames
--write-info-json --sleep-requests 1 --sleep-interval 2 --max-sleep-interval 8
[--cookies <per-run copy of cookies.txt>]
```

yt-dlp writes its cookie jar back on exit, which overwrote TubeSync users' files (#1536). Hence the per-run copy.

| Profile | Arguments |
|---------|-----------|
| Video | `-f "bv*+ba/b" -S "lang,res:<maxHeight>,vcodec:<codec>,acodec:<aac for mp4, opus for mkv>" --merge-output-format <container>` |
| Audio | `-f "ba/b" -S "lang,acodec:<format>" -x --audio-format <format>` |

`lang` comes first so the original audio track beats an automatic AI dub. TubeSync users got an English dub instead of the Spanish original (#1187). That would feed Whisper the wrong language. Prototype P2 verifies the sort order on a video with dubbed tracks.

### Error classes

`classifyYtdlpError(stderr)` is a pure function with fixture tests built from real stderr lines. Each class maps to one status move.

| Class | Example text | Result |
|-------|--------------|--------|
| `rate_limited` | `HTTP Error 429` | Cooldown; video back to `queued` |
| `bot_check` | `Sign in to confirm you're not a bot` | Cooldown; UI suggests cookies |
| `unavailable` | `Private video`, `Video unavailable` | `unavailable` |
| `members_only` | `members-only content` | `skipped` |
| `upcoming` | `Premieres in`, `live event will begin` | `waiting`, `retry_after` parsed from the text or +1 hour |
| `format` | `Requested format is not available` | Retry once without `-S` codec preference, then `failed` |
| `other` | anything else | Retry with backoff |

## 8. Files on disk

```
/media/YouTube/<playlist folder>/
  <title> [<id>].mp4          (or .mkv, .m4a, .opus)
  <title> [<id>].info.json
  <title> [<id>].en.srt       (source subtitle)
  <title> [<id>].eng.srt      (translation outputs from the task patterns)
<notes folder>/<playlist folder>/<title> (<id>).md
```

- The video ID in every name makes files findable after a data wipe.
- The download folder setting `youtube_download_dir` defaults to `YouTube` under `MEDIA_DIR` and goes through `resolveMediaSubfolder` (`media-paths.ts`).
- The notes folder setting `youtube_notes_dir` defaults to `/notes`, a mount of the vault folder (for example `/nas/vault/YouTube:/notes`). If the folder is missing or not writable, videos stop at `translating` with the reason "Notes folder /notes is not mounted", and a banner says the same.
- Audio extensions stay out of `video_extensions`. Adding them would make `/api/scan` treat music libraries as videos to transcribe. The YouTube worker creates its own jobs, so audio-only transcripts need no scanner support.

## 9. Note format

`renderNote(info, cues, translations)` is a pure function with a golden-file test. Writes go through a temp file and rename. A re-export overwrites the whole note, so it converges.

```markdown
---
title: "Why the Roman Empire fell"
video_id: dQw4w9WgXcQ
url: https://www.youtube.com/watch?v=dQw4w9WgXcQ
channel: "[[History Channel]]"
published: 2026-08-14
added: 2026-09-02          # only with a YouTube API key
duration: "42:10"
playlist: "[[Learning]]"
language: en
transcript_source: youtube_captions   # or whisper:<model>
translations: [zh-TW]
tags: [youtube]
subsmelt_schema: 1
---

# Why the Roman Empire fell

![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

> [!info]- Description
> The creator's description, quoted.

## Chapters
- [00:00](https://youtu.be/dQw4w9WgXcQ?t=0) Intro

## Transcript
[00:00](https://youtu.be/dQw4w9WgXcQ?t=0) Paragraph of merged cues...

## Transcript (繁體中文)
[00:00](https://youtu.be/dQw4w9WgXcQ?t=0) ...
```

- Cues merge into paragraphs that break at chapter starts, or at the first sentence end after 45 seconds.
- The file name avoids `[ ] # ^ |`, which break Obsidian links. Channel and playlist names inside `[[ ]]` get the same treatment.
- The wikilinks point at notes that need not exist. Obsidian still groups every video by channel and playlist in backlinks and the graph.
- `subsmelt_schema` lets myfeed detect format changes later.

## 10. Server changes

- `src/server/youtube/urls.ts` (new). Parse a pasted URL into a list ID. Build canonical playlist and video URLs. Validate IDs.
- `src/server/youtube/ytdlp.ts` (new). Resolve the binary, run it with a timeout, parse JSON and progress lines. Pure `downloadArgs(profile)` and `classifyYtdlpError`.
- `src/server/youtube/video-status.ts` (new). The status enum and transition table.
- `src/server/youtube/store.ts` (new). `YoutubeStore` takes a better-sqlite3 `Database` in its constructor so tests use `:memory:`. `db.ts` opens the real file at import and has no such seam today.
- `src/server/youtube/playlists.ts` (new). Read and write `youtube_playlists`.
- `src/server/youtube/subtitle-routes.ts` (new). Pure `planSubtitles(spokenLang, tasks, creatorCaptionLangs)` returning one route per task (same language, creator captions, or translate), plus the language-code normalising table.
- `src/server/scanner.ts`. Skip the YouTube download folder.
- `src/server/youtube/worker.ts` (new). The two lanes, cooldown and boot reconciliation.
- `src/server/youtube/note.ts` (new). `renderNote` and cue grouping.
- `src/server/youtube/data-api.ts` (new). One function that pages `playlistItems.list` with plain `fetch` and returns video ID to added date. No `googleapis` dependency.
- `src/server/youtube/backfill.ts` (new). Applies a backfill filter to a listing.
- `src/server/notify.ts`. Summary line for `youtube:note`.
- `src/server/gpu-gate.ts` (new). `translationMayStart()` and `transcriptionMayStart()`, reading `gpu_shared`, the running transcription count, the queue state and the YouTube backlog.
- `src/server/queue.ts`. `processQueue()` asks the gate before starting.
- `src/server/routes/youtube.ts` (new). Endpoints below.
- `src/server/config.ts`. Defaults for `youtube_playlists: "[]"`, `youtube_download_dir: "YouTube"`, `youtube_notes_dir: "/notes"`, `gpu_shared: "0"`, `youtube_ytdlp_auto_update: "1"`, `youtube_api_key: ""` (added to `SECRET_SETTING_KEYS`). POST /api/settings rejects keys without defaults.
- `src/server/logger.ts`. Add `"youtube"` to the category union.
- `src/server/index.ts`. Register the routes. Start the worker in `app.listen`.
- `Dockerfile`. yt-dlp and ffmpeg.

Endpoints (plain JSON, `{ error }` on failure, matching the repo):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/youtube/status` | yt-dlp version, ffmpeg found, cookies present, cooldown, transcription ready |
| POST | `/api/youtube/playlists/preview` | `{url, backfill?}` to `{id, title, count, selection: {videos, hours, approximate}}` before following |
| POST | `/api/youtube/playlists/:id/backfill` | Change the backfill filter after following |
| GET, POST | `/api/youtube/playlists` | List with counts per status; follow |
| PUT, DELETE | `/api/youtube/playlists/:id` | Edit; unfollow (keeps files and video rows) |
| POST | `/api/youtube/playlists/:id/sync` | Check now |
| GET | `/api/youtube/playlists/:id/videos` | Video rows |
| POST | `/api/youtube/videos/:videoId/{download,skip,retry}` | User actions |
| POST | `/api/youtube/api-key/test` | Checks the saved or typed key with one `videos.list` call (1 quota unit) |
| PUT, DELETE | `/api/youtube/cookies` | `{content}` as JSON text; no multipart dependency |
| POST | `/api/youtube/ytdlp/update` | Run the updater |

SSE events: `youtube:video` (`{videoId, status, pct?}`), `youtube:playlist` (`{playlistId, lastCheckedAt, error?}`), `youtube:cooldown` (`{until, cause}`), `youtube:note` (`{videoId, title, channel, url, playlistId, notePath, translations}`).

`youtube:note` is also a webhook event. `src/server/notify.ts` gets a one-line summary for it ("📝 Note ready: <title>"), and the Notifications settings list it among the choices for `notify_events`. myfeed can subscribe to it later with the JSON format.

## 11. Client changes

- `app/constants.ts`, `App.tsx`. A `/youtube` nav item (mobile overflow) and lazy route. The active tab uses an exact path match, so the selected playlist lives in `?playlist=<id>`, as Logs does with `?job=`.
- `features/youtube/YoutubePage.tsx`. Playlist list, or one playlist's videos when `?playlist` is set.
  - Empty state explains the feature, recommends an Unlisted playlist, and holds the one primary action, "Follow a playlist".
  - Playlist rows show title, folder, a profile summary ("Audio · m4a · Auto"), counts per status, last check and last error. Actions are Check now, Edit and Unfollow.
  - Video rows show title at full contrast, then channel, duration and published date muted, then a status badge with a glyph and a progress bar while downloading. The row menu holds Download, Skip, Retry and Preview transcript (the existing preview overlay). Filter tabs are All, In progress, New, Done, Needs attention. More than 200 rows virtualize, as `JobsTableDesktop.tsx` does.
  - Banners for cooldown ("YouTube asked SubSmelt to slow down. Paused until 14:20.") and for a missing transcription backend ("Downloads continue. Transcription waits for a backend.").
- `features/youtube/FollowPlaylistDialog.tsx`. URL, then preview, then folder, media profile (Audio or Video, with quality, codec and file as labelled fields), backfill filter (All, None, Posted since, Added since) with a year and month picker and a live size estimate, subtitle languages with the three-route legend, then More options (download timing, subtitle source, check interval, folder). "Added since" stays visible but disabled without a key, with a link to Settings.
- `features/youtube/video-status.ts`. Status to glyph, label key, tone and allowed actions. Pure, with a test.
- `ui/primitives.tsx`. Generalize `StatusBadge` to take a status descriptor instead of `JobRow`. Do this first, in its own commit.
- `features/settings/sections/SttSection.tsx`. The "Transcription and translation share one GPU" toggle.
- `features/settings/sections/YoutubeSection.tsx`. YouTube Data API key (masked, Show, Test key, status line, collapsible setup steps), download folder under `/media/`, notes folder with its mount status, cookies for Private playlists (upload as text, remove, "present since" only), yt-dlp version with Update now and a daily-check toggle.
- `api.ts`, `types.ts`, `hooks.ts`. Endpoints, row types, query keys, and the three SSE names in both the union and `SSE_EVENT_NAMES`.
- Locales. `locale-coverage.test.ts` requires every key in all 32 locales. Keep the `youtube` namespace under about 70 keys and add all locales in the same PR as the UI that uses them.

## 12. Security

SubSmelt has no authentication and binds `0.0.0.0` (README Security, `docs/TODO.md`). This feature raises the stakes, so:

- Cookies never leave the server. The API reports only presence and upload time. The UI says plainly that an Unlisted playlist needs no cookies, and that cookies are a live Google session.
- yt-dlp receives only URLs the server builds from validated IDs, through `spawn` with an argument array. No `--exec`.
- The user runs SubSmelt on the home network only (U16), so this feature adds no login. If that changes, authentication comes before cookies or the API key are stored.
- Every path goes through `media-paths.ts` helpers. The notes folder must exist and be writable, and is checked at save.
- Nothing is deleted from disk by sync. Unfollow keeps files.

## 13. Delivery

Each PR ends in a state the user can check. Run `npm test` and `npm run typecheck` on every PR. `package.json` has no lint script.

**Test lever.** `src/server/youtube/fake-yt-dlp.mjs` replays canned listings, info JSON, progress lines and stderr, and writes small files. `SUBSMELT_YTDLP_BIN` points the wrapper at it, so worker tests run offline. `scripts/youtube-smoke.sh` runs the real binary in the container against one public test playlist.

| PR | Scope | Depends on | You see |
|----|-------|-----------|---------|
| 1 | Runtime: yt-dlp and ffmpeg in the image, `ytdlp.ts`, `urls.ts`, `/api/youtube/status`, updater | P1, P3 | Status endpoint reports the yt-dlp version. The smoke script lists a playlist inside the container. |
| 2 | Follow and sync: `store.ts`, `video-status.ts`, `playlists.ts`, sync step, playlist routes, YouTube page (list, follow dialog, video rows), `StatusBadge` refactor, locales | 1 | Follow an Unlisted playlist and its videos appear. Remove one on YouTube, Check now, it shows "removed". |
| 3 | Download: profiles, download step, progress, auto and manual, backfill, Skip and Retry, cooldown, boot reconciliation, cookies | 2, P2 | A 720p mp4 and an m4a arrive in `/media/YouTube/<folder>`. Kill the container mid-download; after restart it finishes with no temp leftovers. |
| 4 | Subtitles and translation: captions or transcription, per-language routes, direct job creation, scanner exclusion, finish step, GPU gate | 3 | A Chinese video with English and Traditional Chinese picked gets `zh-TW` from its transcript and English from translation. An English video with creator Chinese captions gets both with no LLM call. With `gpu_shared` on, the Jobs page shows no translation while Whisper runs. |
| 5 | Notes: `note.ts`, notes folder setting, export and re-export, `youtube:note` webhook | 4 | The note opens in Obsidian with working timestamp links and channel backlinks. A test webhook to ntfy shows "Note ready". |

Unit tests to add, each asserting literal expected values:

- `urls.test.ts`. Playlist, watch-with-list, `music.youtube.com` and garbage URLs.
- `ytdlp.test.ts`. `downloadArgs` for each profile. `classifyYtdlpError` for each fixture line.
- `video-status.test.ts`. Every allowed and refused transition.
- `store.test.ts`. Listing upsert, removal guard (count mismatch leaves rows untouched), tombstones survive sync.
- `backfill.test.ts`. Each filter on a fixture listing. "Posted since" requests exact dates only for entries inside the rounding window. Changing the filter leaves user skips alone.
- `data-api.test.ts`. Pagination over `nextPageToken` and the `publishedAt` mapping, with `globalThis.fetch` stubbed.
- `worker.test.ts`. With the fake binary, a playlist goes from sync to `done`. A 429 sets the cooldown. A crash at each step converges after restart.
- `note.test.ts`. Golden file. Cue grouping at chapter starts.
- `subtitle-routes.test.ts`. Each route on literal inputs: same language, creator captions present, translation fallback, and code normalisation (`zh-TW` vs `zh-Hant`, `en` vs `eng`).
- `gpu-gate.test.ts`. Held while a video is `transcribing`; released when the backlog is empty; released during cooldown; transcription held while the queue runs.
- Client `video-status.test.ts`. Actions per status.

## 14. Prototypes to run before building

These are facts to observe, not choices to ask about.

| # | Question | How to settle it |
|---|----------|------------------|
| P1 | Does the standalone yt-dlp list and download YouTube inside `node:22-slim` with `--js-runtimes node`? | **Pass.** See Appendix B. |
| P2 | Does `-S lang,...` pick the original audio on a video with AI-dubbed tracks? | **Pass.** See Appendix B. |
| P3 | How much does ffmpeg add to the image? | **Settled.** Minimal source build, 7 MB. See Appendix B. |
| P4 | Does a flat listing of an Unlisted playlist report `playlist_count`? | **Pass.** See Appendix B. |
| P5 | Does an Unlisted playlist list without cookies from a home IP? | **Pass.** See Appendix B. |
| P6 | Does `playlistItems.list` with only an API key return an Unlisted playlist's items and `snippet.publishedAt`? | Needs the user's API key. Run one request against the test playlist. If it fails, "Added since" is limited to Public playlists. |

## 15. Resolved questions

The user answered the open questions on 2026-09-30. See U6 to U12.

## 16. Risks

- **YouTube blocking.** The main failure in TubeSync's tracker. Mitigated by the serial lane, sleeps, cooldown, daily yt-dlp update, cookies as a fallback. Lands in PR 3.
- **Language code mapping.** Same-language detection compares Whisper or YouTube codes (`en`, `zh-TW`, `yue`) with task targets. One normalising table owns that mapping; a miss falls back to translating, which costs tokens but never loses a subtitle.
- **Scanner exclusion.** Users who already point the scanner at the download folder would stop getting scanner jobs there. The Settings YouTube section says so next to the download folder.
- **Long translation backlogs delay YouTube.** With `gpu_shared` on, a library-wide translation run holds every YouTube transcription until it finishes.
- **Locale churn.** Every new string lands in 32 files.
- **Uncommitted work.** `db.ts`, `queue.ts`, `index.ts` and `scanner.ts` have uncommitted changes in the working tree. Start PR 2 after they land. PR 4 edits `queue.ts`.
- **Disk use.** Video at 1080p is 1 to 2 GB per hour. Audio playlists are the answer for knowledge-only use.
- **Terms of service.** YouTube's terms forbid downloading outside its own apps. SubSmelt is published; the feature carries the same risk as MeTube or TubeSync.

## Appendix A. What we took from TubeSync, and what we left

Taken, in our own code:

- Flat listing, upsert on the video ID, full metadata only when needed.
- Original audio track first.
- Removal only when the listing is complete, and never deleting files.
- One serial lane for YouTube traffic.
- Tombstones for skipped videos.
- Per-video temp folders cleaned at boot.
- A hard timeout per download.
- Waiting on premieres.
- A per-run copy of cookies.
- The video ID in every file name.

Left out:

- Four booleans for one status.
- Four task queues in four SQLite files.
- Locks that leak.
- The format fallback cascade.
- The token server, cipher server and nginx balancer.
- Renaming every file on every index.

TubeSync also has two gaps in removal detection. Its entry limit and its download-cap date range both shrink the listing without failing its count check. Our guard compares against `playlist_count`, and we never apply a date range to the listing.

## Appendix B. Prototype evidence

Run on 2026-09-30 on Docker 29.8.1, arm64, with yt-dlp 2026.08.19 standalone (`yt-dlp_linux_aarch64`) and ffmpeg 7.1.2. The throwaway Dockerfiles are in the session scratchpad (`proto-ytdlp/`). None of this is production code.

**P3. Image size**, measured with `du -sxm /` inside each image:

| Image | Size | Added |
|-------|------|-------|
| `node:22-slim` | 251 MB | |
| plus Debian `ffmpeg` (5.1.9) and yt-dlp | 680 MB | 429 MB |
| plus yt-dlp's static ffmpeg build (133 MB each for ffmpeg and ffprobe) and yt-dlp | 542 MB | 291 MB |
| plus minimal ffmpeg 7.1.2 (3.6 MB ffmpeg, 3.5 MB ffprobe) and yt-dlp (40 MB) | 296 MB | 45 MB |

The minimal build used `--disable-everything --disable-autodetect --enable-small` plus these components:

- protocols `file,pipe`
- demuxers `mov,matroska,ogg,webvtt,srt,ass,aac,mp3,ffmetadata,concat`
- muxers `mp4,ipod,mov,matroska,webm,ogg,opus,srt,webvtt,ass,adts,ffmetadata,null`
- decoders `aac,opus,vorbis,mp3,webvtt,subrip,srt,ass,mov_text`
- encoders `aac,srt,subrip,webvtt,ass,mov_text`
- all parsers and bitstream filters
- filters `aresample,aformat,anull,null,atrim,copy`

**P1. yt-dlp in the minimal image with `--js-runtimes node`**, on TED-Ed video `qD0_yWgifDM` (3 min 55 s). Every step printed no warnings.

- Flat listing of `UUsooa4yRKGN_zEE8iknghZA` returned `playlist_count` 2384 and `availability` public.
- Video, `-f "bv*+ba/b" -S "lang,res:360,vcodec:h264,acodec:aac" --merge-output-format mp4`. Formats 134 and 140 merged into an mp4. ffprobe reported `h264,360` and `aac`.
- Audio, `-f "ba/b" -S "lang,acodec:aac" -x --audio-format m4a`. yt-dlp logged "file is already in target format m4a", so no re-encode.
- Audio, `-S "lang,acodec:opus" -x --audio-format opus`. The result was Ogg with Opus.
- Captions, `--skip-download --write-subs --sub-langs en --convert-subs srt`. It produced `s-qD0_yWgifDM.en.srt` with correct cues.
- The same `-F` without `--js-runtimes node` printed "No supported JavaScript runtime could be found... some formats may be missing". The flag is required.
- The info JSON was 726 KB. Stored copies should drop the formats list and expiring URLs.

**P2. Original audio**, on MrBeast video `1WEAJ-DFkHE` (language `en`).

- The video has 75 audio-only formats across dubbed languages. Examples are `es | Español - dubbed` and `ja | 日本語 - dubbed`.
- The original track carries `language_preference` 10 and `format_note` "English original (default)".
- Both `-S "lang,acodec:aac"` and `-S "acodec:aac"` picked `140-24 en English original (default)`.
- yt-dlp already ranks the original first. We keep `lang` first in the sort anyway, so a later default change cannot flip it.

**P4 and P5. The user's Unlisted playlist**, `PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8`, listed with no cookies:

- The exit code was 0 and no warnings were printed.
- `availability` was unlisted.
- `playlist_count` was 889, and so was the number of entries. The removal guard can compare the two.
- 7 entries have no title and no duration. They are private or deleted videos, and YouTube still counts them. The sync step must store them as `unavailable` rather than dropping them, or the counts stop matching.
- The `si=` tracking parameter in the shared URL is ignored. The server rebuilds the URL from the list ID.

The same playlist sizes a backfill:

- 374.7 hours of video. The median video runs 16.1 minutes, 63 videos run over an hour, and the longest runs 7.4 hours.
- Audio at about 128 kbit/s comes to roughly 21 GB. Video at 720p comes to roughly 200 to 400 GB.
- Transcript text comes to roughly 3.4 million words per language. A local LLM costs time only. A cloud model costs money for every translation language.
- This is why the GPU gate has a batch cap, and why each timeout scales with the video's duration.

**Dates in the user's playlist**, listed again with `youtubetab:approximate_date`. Flat entries carry `timestamp`, the approximate publish date, and no added date.

- The playlist is newest-first. The top tenth has a median publish date of 2026-09-09 and the bottom tenth 2023-09-30.
- Rounding is visible. Neighbouring entries read 2026-08-30 then 2026-07-30, which are "1 month ago" and "2 months ago". Exact dates near a cutoff need the per-video call.
- Posted in or after August 2026: 98 videos. Published in or after January 2026: 374 videos.
- For scale, the top 105 entries come to 39.7 hours and about 2.3 GB of audio. The top 388 come to 158.2 hours and about 9.2 GB.

**Check cost.** A full flat listing of the 889-video playlist took 5 seconds, container start included, and returned 1.2 MB of JSON. An hourly check is cheap, and the 15-minute minimum is safe.

The playlist RSS feed, `https://www.youtube.com/feeds/videos.xml?playlist_id=<id>`, answered for the Unlisted playlist in 0.5 seconds with HTTP 200. It returned 15 entries in playlist order, starting with the same top three IDs as the listing. For a newest-first playlist it could detect additions every few minutes with one plain request. It misses removals and older positions, so it could only ever supplement the full listing. Not planned. Build it only if hourly detection feels slow.

