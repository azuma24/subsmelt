# Changelog

All notable changes to SubSmelt. The app and the Windows Whisper backend share a
version number and are released together (`v0.5.6` and `whisper-v0.5.6`).

## [Unreleased]

## [0.6.8] — 2026-10-09

### Added

- **Usage page under Settings.** Every successful LLM call is now recorded with its model, connection, call type, file, input and output tokens, cache and reasoning tokens, and a cost estimate priced when the call ran. The page charts tokens and cost per day, ranks models, call types and files, and lists the last 50 calls, for 7, 30 or 90 days, a year or all time. Calls from the Convert page and title repair are counted too. `GET /api/usage?range=30d` returns the same report, and `DELETE /api/usage` clears the history.

### Changed

- **Library and Activity are one home page.** `/` opens the Library with the queue on one line above it (the running file, its progress and time left, how many wait, and Run all or Stop), the setup checklist cut to the steps still left, and a `Files | Jobs | Transcriptions` switch. Jobs lists every job, Convert uploads included, with the old retry, re-translate, delete and clear-finished actions and the folder and language filters. The view, file filter and job status live in the URL (`/?view=jobs&status=error`), so the failure toast opens the failed jobs and a bookmark keeps its view. A file's side panel opens its job details in place. Old `/activity` links redirect to the Jobs view. The nav loses the Activity item and the error badge moves to Library. The token and cost tiles are gone; Settings → Usage has them.

## [0.6.7] — 2026-10-07

### Added

- **A favicon and a theme-coloured browser chrome.** The tab shows the SubSmelt mark, and the address bar on phones takes the page's background in dark and light mode. The `/favicon.ico` 404 on every page load is gone.
- **`HOST`** environment variable: the web server binds every interface by default, as before; set `HOST=127.0.0.1` to keep it local to the machine.
- **Baseline security headers** on every response (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).

### Changed

- **One page header everywhere.** Library, Activity, Transcribe, YouTube, Convert, Settings, Translations and Logs share the same sticky header, and it wraps its actions under the title on a phone instead of squeezing the title. Text glyphs (`↻`, `⋯`, `○`, `⚠`, `▸`) are icons, and every select, textarea and toggle comes from one kit, so they look and focus the same on every screen.
- **Faster to open, lighter to run.** The subtitle converter's language detection loads on first use instead of with the app, and its charset sniffing is a few kilobytes of the app's own code instead of a megabyte of library; React, the router and the query library ship as their own long-cached chunks; hashed assets are served with a one-year cache. While the live event stream is open the pages poll the API far less often (jobs every two minutes instead of every 30 seconds), since the stream already announces every change. The library scan no longer blocks the server while it walks a large tree.
- **Settings are checked by kind.** Every setting has one definition shared by the client and the server; a flag, a number out of range or an unknown enum value is refused with a message that says the allowed range, and the queue reads typed values instead of parsing strings.
- **Subtitle previews of `.ass` files** show the right cue times.
- **Dependencies:** React 19, Express 5, Vite 8, Tailwind CSS 4, Vercel AI SDK 7, zod 4, chokidar 5, jschardet 4. The oldest browsers Tailwind 4 supports are Safari 16.4, Chrome and Edge 111 and Firefox 128.

### Developer

- **Linting and formatting:** Biome for the TypeScript halves (`npm run lint`, `npm run format`) and ruff for the Whisper backend, both run in CI. The whole tree was formatted once; `.git-blame-ignore-revs` lists that commit.
- **Twelve packages fewer.** Subtitle parsing (SRT, WebVTT, ASS), charset detection, the download's ZIP writer, the translation runtime, the dev runner, the scan's concurrency pool and the CORS stub are the app's own code now (`src/server/translator/{srt-vtt,ass}.ts`, `src/shared/charset.ts`, `src/client/features/convert/zip.ts`, `src/client/i18n/`, `scripts/dev.mjs`), each with tests that pin the old behaviour. Gone: subtitle, ass-parser, ass-stringify, jschardet, iconv-lite, jszip, i18next, react-i18next, i18next-browser-languagedetector, concurrently, cors, tiny-async-pool. zod stays as the AI SDK's required peer.
- `src/shared/` holds the API types and the settings table both sides use. The client's hooks live in `hooks/`, its primitives in `ui/`; the queue runs a job as stages in `src/server/queue/`. Catch blocks and SDK errors are typed on the server; there is no `any` left outside tests.

## [0.6.6] — 2026-10-06

### Added

- **One language code in every file name.** Everything SubSmelt writes uses the three-letter code: `Movie.eng.srt`, `Movie.kor.srt`, `Movie.jpn.srt`. Your preferred Chinese is `.chi`; the other script is `.chs` or `.cht`. Files already named another way (`.en`, `.zh-TW`, `.english`) count as the same language, so nothing is renamed or translated twice. Saved translation tasks move to the standard code on their own.
- **Preferred Chinese** (Settings → Sources) decides which script `.chi` means. Whisper transcripts in Chinese are converted to it (OpenCC), and `.chi`/`.zh` files count as it.
- **Transcripts are named with their language,** set or detected: an "auto" run writes `Movie.eng.srt`, not `Movie.srt`. Re-transcribing with overwrite confirmed replaces the old transcript.
- **Brazilian and European Portuguese** (`pt-BR`, `pt-PT`) are distinct languages, like the Chinese scripts.
- **Docker:** a health check, and optional `PUID`/`PGID` so `config/` and `data/` belong to your user. Without them the container runs as before.

### Changed

- **The Library shows one chip per language** with its most pressing state, and a translation that already exists reads "Already translated".
- **Faster releases:** images build natively on amd64 and arm64.
- **Translations:** proper plural forms in Russian, Ukrainian, Polish, Czech, Romanian, Hebrew and Arabic, and most strings still in English are now translated in every language.

### Fixed

- **Library:** a source and its own translation could each count as the other's output, leaving a video with no subtitles; upper-case video extensions (`.MKV`) never matched their subtitles on Linux; `$` in a file name broke the output name; a deleted translation was never redone; a disabled task's translation was read as a second source; `zh-Hant`, `es-419` and Bazarr's `zt` were not recognised, while `Episode.VI` was read as Vietnamese; lookups depended on letter case.
- **Queue:** jobs created while a "Run pending" was active stayed pending forever; the job list re-downloaded in full on every progress tick.
- **YouTube:** YouTube's soft rate limit marked queued videos unavailable for good (already affected videos are requeued); one video waiting for a transcription backend blocked subtitles for all the others; previews and Check now waited behind long downloads; cookies were not used for listings; a video that went from private to public was never downloaded; a "posted since" first sync restarted from zero after a rate limit; transcribing videos showed "Downloading"; group counts only counted the rows on screen.
- **Speech-to-text:** shared mode now accepts a Windows backend path (`D:\Media`, `\\nas\media`); long runs are no longer killed at 30 minutes while they make progress; manual and scan transcriptions wait for translation on a shared GPU; a second run of the same file is refused; silence is reported as "no speech" instead of an empty transcript; history retries keep their device, compute type and options. Backend: cues are no longer cut by a blank line, Windows upload names with `? : *` work, a cancel stops audio extraction and never writes a file.
- **Security and settings:** other websites can no longer trigger actions through your browser; a config file that fails to load is never silently replaced; settings set by environment variables are shown read-only and never written to `config.json`; cloud LLM connections are really checked; the notification webhook is redacted; numeric settings are range-checked; old log rows are pruned.

## [0.6.5] — 2026-10-06

### Added

- **Follow a YouTube channel.** The YouTube page has separate **Add playlist** and **Add channel** actions. Paste a channel link, `@handle` (in any script), `/channel/UC…`, `/c/…` or `/user/…` link. A channel is followed as its uploads, so downloads, subtitles, translation and notes work as they do for playlists, and **None** (the default) keeps only videos uploaded from now on. Followed channels show a **Channel** tag.
- **Shorts and live streams are off by default.** The channel dialog has **Also follow: Shorts / Live streams**, each with its count. What a follow leaves out is listed under Skipped as "Short, not followed" or "Live stream, not followed". Turning a kind on later applies the follow's backfill to it, so it never queues years of old Shorts unless the backfill asks for them.
- **Pick older videos in bulk.** The Skipped tab has a checkbox on each row, **Select all shown**, a selected count and **Download N**, so you can choose exactly which older videos to keep. `POST /api/youtube/playlists/:id/videos/download`.
- **See every LLM connection from the sidebar.** The model badge is now a status line: `LLM · Fallback · 3 connections`, or `Translating on <name>` while a job runs (`2 of 3 busy` in parallel mode). Its dot is green when every connection answers, yellow when some are offline and red when none answer. Clicking it lists each connection in fallback order with its model, host and state (in use by which job, idle, offline). On phones it sits in the Activity header. `GET /api/llm/status`.

### Changed

- **Big downloads need a confirmation.** Following, or changing a backfill or the Shorts and live choice, in a way that would download more than 100 videos keeps Follow or Save disabled until "Yes, download all N videos now" is ticked, with the estimated hours and size shown beside it.

## [0.6.4] — 2026-10-05

### Added

- **A Library page is the new home.** `/` lists every media file grouped by folder, with one chip per target language showing its status. A row of status filters with counts (Errors, Needs transcription, Missing a language, In progress, Done) narrows the list to what needs attention, showing each file's folder path. Selecting a file opens a side panel with every action for it: retry a failed translation, preview, cancel, **Translate to…** any language, or transcribe a video that has no subtitles. It becomes a bottom sheet on phones. Select several files to transcribe them or run their pending jobs together. J/K and the arrow keys move through the list, and Enter opens a file.
- **A five-item navigation.** The nav is Library, Activity, Transcribe, YouTube and Settings, and the phone bar shows exactly these five, with no More sheet.
  - The old Dashboard is **Activity** at `/activity`. It keeps the queue and transcription tabs, and the Library replaces its scan tab.
  - **Languages** (formerly Translations) and **Logs** live under Settings. Old links to `/translations` and `/logs` redirect.
  - The converter opens from **Upload file** in the Library header.
- **Translate one file into any language.** Pick one of your languages or type any language. A language you have no task for gets a disabled task, so library scans never apply it to other files. `POST /api/jobs/translate-file`.
- **See which model is translating.** The Currently translating card and the job rows show `machine · model`. The display follows fallback switches, including a switch back to an earlier connection.

### Changed

- **One design system across the app.**
  - **Type scale.** Seven steps, with nothing under 12px.
  - **Corners and shadows.** Two corner radii and two shadow levels.
  - **Spacing.** A 4px scale.
  - **Colors.** Color role tokens.
  - **Motion.** One motion curve, and `prefers-reduced-motion` is honored.
  - **Focus.** One visible keyboard focus ring.
  - **Icons.** Line icons replace emoji.
  - **Touch targets.** Controls on Transcribe and Settings are at least 44px tall on phones.
- **Light mode's muted text is legible.** It now meets WCAG AA contrast, 4.88:1 where it was 3.46:1.

### Fixed

- **The desktop queue table stacked every cell of a row** on its own line at 768 and 1280px, a regression from 0.6.3's row memoization. Rows are real grid rows again, with the active job highlighted.
- **The subtitle preview hid the subtitles.** The plot summary and glossary block now starts collapsed, so cue rows show as soon as the preview opens. Long previews no longer leave blank space after toggling that block.
- **A slow or failed queue load said the queue was empty.** It now shows skeleton rows while loading, and an error with Retry if the load fails.
- **The scan confirm dialog contradicted itself.** Its counts now agree. It says when nothing new will be queued, and when no translation target applies.
- **Transcription history showed raw timestamps and status codes.** It now shows relative times and translated statuses.
- **Whisper backend: a run of short cues collapsed onto its last second.** Three or more short cues in a row from the same speaker merged into one cue timed to the final segment, which hid the earlier speech. Runs are now measured from their first start.
- **Re-queuing a failed one-off translation wrote the old filename** if the language's naming had changed since.
- **Whisper backend: a short lead-in made a merged cue start too early.** A breath word or false start at 0:00 was merged into the next cue at the earlier start time, so the next sentence appeared seconds before anyone said it. Forward merges now start when the following text is actually spoken.
- **Translation against LM Studio failed with "Bad Request" and then timed out.** The context probe read the model's maximum context, 262144 tokens, instead of the context LM Studio had loaded, 8192 tokens, so prompts were sized for a window 32 times too large. The probe now prefers the loaded context.
- **Context overflows are recovered instead of failing the job.** Servers report an overflow as a bare "Bad Request", and LM Studio shares one context window across concurrent requests. Overflows are now recognised (LM Studio, llama.cpp, OpenAI, vLLM, Anthropic, Gemini): an oversized analysis is resent with fewer lines, and chunks that overflow a shared window halve the number translated at once and retry, instead of falling back to line-by-line translation.
- **Every connection is probed, not just the primary.** A fallback connection with a smaller context gets prompts sized for itself, and `parallel_chunks` is capped to what the primary's context window holds.
- **Subtitles, transcripts, YouTube downloads and notes were read-only from other computers.** The container runs as root, so its files came out `644` and its folders `755`. These outputs, and the folders created for them, are now writable by everyone (`666` and `777`). App data keeps its permissions, and the config file is created `0600`. Files created before this release keep their old permissions; fix them once with `chmod -R a+rwX` on the media folder.

## [0.6.3] — 2026-10-02

### Changed

- **The dashboard stops re-rendering every row on each progress tick.** Translating rows are memoized (desktop table and mobile cards), the job actions hook keeps a stable identity, and the row's displayed state comes from one shared helper — so a progress update re-renders only the translating row, not all of them. Large libraries finally stay smooth while a job runs.
- **Row and card display state comes from one place.** File name, progress, error reason and status-derived flags were derived independently in the desktop table and the mobile card; both now share `jobDerived`, so a new status is one edit instead of two.
- **The file tree skips offscreen rows** (`content-visibility`) instead of rendering every file in an expanded folder.

## [0.6.2] — 2026-10-02

### Fixed

- **A database error mid-run crashed the whole server.** Queue starts from routes, the watcher, boot resume and the YouTube worker left `processQueue()`'s rejection unhandled, and one failed claim or query killed the process. Queue starts now catch their own failures, and an `unhandledRejection` backstop logs instead of crashing.
- **A failed scan permanently excluded videos from auto-transcription.** `/api/scan` claimed videos before transcribing them but only released them per file, so a failure after claiming left them claimed until restart. Claims are now released in a `finally`.
- **One failed disk flush froze transcription-history persistence for good.** The write chain stayed rejected, so every later write silently never reached disk. The chain now recovers and logs.
- **The YouTube worker could die on its 30-second tick** when finishing translated videos threw; the tick catches and the next pass retries.
- **`GET /api/llm-health` could hang forever** on a response whose body never arrived; the JSON read is now deadlined like the headers were.
- **`job:analysis` events were broadcast but never consumed** — the event was missing from the client's SSE registry. The jobs list now refreshes when an analysis lands.

### Changed

- **Scans stop doing one database query and one file check per subtitle per task.** Job states load once per scan and output existence is answered from the walked file set: a steady-state scan of 500 videos × 2 tasks measured 31 ms → 9 ms, and the gap grows with library size.
- **The dashboard list stops shipping the analysis blob it never displays**, sorts through a fitting index, and counts pending jobs with `COUNT(*)` instead of loading every row; the logs table gained `job_id`/`level` indexes.
- **Whisper progress renders coalesce** into one update per 200 ms window (terminal events land immediately) instead of re-rendering the page per backend segment.

## [0.6.1] — 2026-10-01

### Added

- **Cancel a single translating job.** Each translating row on the dashboard now has Cancel next to Preview (a danger button on mobile). It aborts that job's LLM calls, ends it as a cancelled error you can Retry — keeping its partial output so the retry resumes — and the queue keeps running with the next pending job. Stop keeps its old meaning: everything aborted, every job back to pending.
- **See which machine is running what.** In parallel mode, every translating row names the LLM connection running it (with its host on hover), and `/api/queue/status` lists all active job–connection pairs. The attribution follows fallback switches live.
- **Cancel actually stops transcriptions.** The Transcribe page's Cancel now also stops every in-flight transcription — including runs the page displays but doesn't own (another tab, a run that survived a reload, auto-transcription) — which previously kept running with no way to stop them. The Cancel button now appears whenever anything is visibly transcribing, not only during a batch, and closing the page (or a reload) aborts the run it started instead of leaving the backend transcribing into the void.

### Fixed

- **A cancelled job poisoned its own retries.** A cancel racing a completing job left its marker behind, so every later retry of that job failed instantly with "Cancelled by user".
- **A cancel landing during the model-context probe was ignored** until the first translation call; the probe now honours the job's abort signal.
- **A stop arriving during a cancel** could label a job "Cancelled by user" instead of returning it to pending like its siblings.
- **Better-sqlite3 had no binding on Node 26** and failed to compile (`v8::Object::GetPrototype` was removed); the pin moved to 13.0.3, which ships prebuilds for current Node.
- **The Docker build failed compiling better-sqlite3**: npm auto-runs node-gyp for its `binding.gyp`, and the image has no Python — `npm ci` now skips install scripts, which nothing needs (better-sqlite3 ships N-API prebuilds; esbuild's script is a fallback for its platform binary).
- **Translations could be written outside the media folder.** A task's output pattern reached `path.join` unsanitized, and the queue — unlike the preview and download routes — never re-checked the path before writing. Patterns containing `..` or an absolute prefix are now refused at task create and update, and the queue asserts both job paths under MEDIA_DIR before translating.
- **The zh-TW task resolved to plain "zh"**, so Chinese videos copied their Simplified transcript as a zh-TW file without translating. The task now resolves to zh-Hant: Chinese videos get a proper Traditional translation, and `zh-Hant` videos take the cheap copy route.
- **Downloaded videos whose files were saved without the `[id]` bracket** were re-downloaded; the adoption check now matches the bare video id too.
- **`config.json` (plaintext LLM keys) was written 0644**; it is now 0600 like `cookies.txt`.

### Changed

- **SSE endpoints are capped** at 100 live connections with one shared heartbeat, so a connection storm can no longer exhaust file descriptors.
- **Overlapping scans share one walk**: a second `POST /api/scan` receives the running scan's result instead of queueing another full-tree walk that freezes the event loop.
- **Eleven more translation presets** — Russian, Arabic, Thai, Vietnamese, Indonesian, Dutch, Polish, Turkish, Hindi, Ukrainian and Swedish joined the quick-add list (20 in total), every language the subtitle router supports. (Also in the replaced 0.6.0 image.)

## [0.6.0] — 2026-10-01

App `v0.6.0` and Whisper backend `whisper-v0.6.0`, released together.

The Windows installer attached to `whisper-v0.6.0` was rebuilt the same day. The
first upload did not start (`No module named 'wave'`: the PyInstaller spec never
analysed the backend's own imports), and its Whisper models failed to decode
audio (`open() got an unexpected keyword argument 'metadata_errors'`: an unpinned
PyAV 19). The rebuilt installer fixes both and builds from locked dependencies.

### Added

- **NVIDIA Nemotron 3.5 ASR** as a second speech-to-text engine next to Whisper. Pick `nemotron-3.5-asr` in Settings or per run, download its 742 MB GGUF from the model manager, and get punctuated subtitles with word-level timing in 32 languages, several times faster than `large-v3` at a fraction of the VRAM. The backend runs it through the bundled NeMo-Speech.cpp 0.1.0 runtime (`nemo-speech`, checksum-pinned in the Docker image and the Windows installer; `SUBSMELT_NEMO_SPEECH` for source installs). Long audio is split at silences into chunks of about ten minutes so progress and cancel keep working. The backend advertises `capabilities.modelInfo` (engine, languages, supported options per model); the UI groups models by engine, hides options a model ignores, warns when a model does not support the chosen language, and the heading "Whisper Models" became "Speech-to-text models". A model that does not support the requested language is refused with `language_not_supported` (formerly `english_only_model`), a missing runtime with `engine_unavailable`, and the low-RAM downgrade never switches engines.
- **Eleven more translation presets** — Russian, Arabic, Thai, Vietnamese, Indonesian, Dutch, Polish, Turkish, Hindi, Ukrainian and Swedish joined the quick-add list (20 in total), every language the subtitle router supports.
- **YouTube playlists.** A new YouTube page follows playlists shared as Unlisted links (no login; a cookies.txt upload covers Private ones). Per playlist, pick audio (m4a or opus) or video (quality, codec, container), the subtitle languages you want, and a backfill filter: All, None, Posted since, or Added since (needs an optional YouTube Data API key, tested from Settings). New videos download one at a time through a serial lane with live progress; YouTube rate limits and bot checks pause the lane for an hour, doubling to a day, instead of retrying into a ban. Each picked language comes from the transcript when the video is already in that language, from the creator's captions when YouTube has them, and otherwise from Whisper then LLM translation. When Whisper and the LLM share one GPU (`gpu_shared`), they take turns in batches. Every finished video gets one Obsidian note in the mounted `/notes` folder, with wikilinks for channel and playlist, the video embed and timestamped paragraphs per language, and a `youtube:note` webhook. The Docker image now bundles pinned yt-dlp and a minimal ffmpeg; Settings shows the yt-dlp version and updates it into the data folder. Removed videos keep their files.

### Changed

- **Clear finished replaces Clear All.** The dashboard button now removes only done, skipped and failed jobs. Pending and running jobs stay in the list.
- **Phone dashboard header** shows Preview Scan, Scan Folders and Run All inline; the page name comes from the bottom tab bar.
- **Settings keep unsaved edits** when the page refetches in the background, and a late autosave no longer hides a pending change.
- **Job failures collapse into one toast** with a count, Open Dashboard and Dismiss all.
- **Page titles match the navigation** (Transcribe, Convert / Translate), and every topbar is the same height.
- **Environment-pinned settings** are applied in memory and no longer written into `config.json`. `GET /api/settings` lists them in `_env_pinned`.
- **Retry, force and delete** on a job that is translating return 409 instead of resetting it under the running worker.
- **Flagged subtitle names** such as `Movie.en.sdh.srt` and `Movie.zh-TW.srt` now pair with their video and name their output like `Movie.en.srt` does.

### Fixed

- **A "Traditional Chinese (Taiwan)" task resolved to plain "zh"**, so Chinese videos copied their Simplified transcript as a zh-TW file without translating. The task now resolves to zh-Hant: Chinese videos get a proper Traditional translation, and `zh-Hant` videos take the cheap copy route.
- **Translations could be written outside the media folder.** A task's output pattern reached `path.join` unsanitized, and the queue — unlike the preview and download routes — never re-checked the path before writing. Patterns containing `..` or an absolute prefix are now refused at task create and update, and the queue asserts both job paths under MEDIA_DIR before translating.
- **Downloaded videos whose files were saved without the `[id]` bracket** were re-downloaded; the adoption check now matches the bare video id too.
- **`config.json` (plaintext LLM keys) was written 0644** like `cookies.txt` is now 0600.
- **Long media path in Settings → Sources** wrapped instead of pushing the page sideways.
- **Windows service never found its bundled ffmpeg** on PyInstaller 6 builds, because it landed under `_internal\`; it now sits beside `run_server.exe` and `SUBSMELT_FFMPEG` is set again.
- **Saved API key wiped on Settings save** for installs still using the single `api_key` setting. The redaction marker was stored as the key and every translation failed to authenticate. If this already happened, enter the key once more.
- **Stored API key sent to any endpoint.** `/api/models?endpoint=...` attached the saved local key to whatever address the caller supplied.
- **Test and Fetch models failed on saved cloud connections** after a reload.
- **Translations cut down to a quoted phrase.** A line such as `他說「我要走了」然後離開` came back as `我要走了`, and two-line answers kept only the last line.
- **Subtitles skipped or translated twice.** `Movie.v2.srt` next to `Movie.srt` was mistaken for an output, and two sources that map to one output ran on the same file.
- **Queue did not resume after a restart**; jobs interrupted by a restart now continue automatically when auto-translate is on.
- **A failed chunk left sibling workers** calling the LLM and rewriting the partial file.
- **Deleting a language** left its pending jobs, which then translated into English.
- **A broken `config.json` was overwritten with defaults.** It is now backed up to `config.json.broken-<time>` and left alone until you save.
- **WebVTT files with STYLE blocks or text cue identifiers** failed to parse.
- **Folder names containing commas** could not be selected for scanning.
- **Convert produced mojibake** for Big5, Shift_JIS, GBK and CP1252 subtitles.
- **Language switch** left most of the UI in English until another re-render.
- **Whisper batches** kept running invisibly after leaving the page; they now show progress and Cancel on return. History Retry can no longer start overlapping runs.
- **Symlinked media folders** broke path mappings and per-folder transcription defaults.
- **Parallel mode waited 30 seconds per chunk** when cascading to a busy connection.
- **Keyboard support** in row action menus (focus, arrow keys, Escape).

### Fixed (Whisper backend)

- **Windows service reported ffmpeg missing** when ffmpeg came from `SUBSMELT_FFMPEG` rather than PATH.
- **Switching models stacked them in GPU memory.** One model stays resident; deleting a model unloads it first, which also releases its Windows file lock.
- **Cancelled or dropped streams leaked temp media** and logged a traceback.
- **Japanese and Chinese subtitles ignored line length and cue duration.**
- **Diarized cues merged two speakers** into one line.
- **URL fetches** re-check redirected hosts and cap downloads at 5 GiB; playlist and channel URLs are refused on the single-file endpoint.
- **`/health?model=`** no longer reveals whether arbitrary paths exist.
- Upload names like `..` return 400; non-ASCII tokens return 401; whitespace-only cues are dropped.

## [0.5.9] — 2026-09-09

App + Whisper backend (`v0.5.9` and `whisper-v0.5.9`).

### Added

- Distil model labelled English-only in Settings and Transcribe, with a hint to use large-v3 / large-v3-turbo for Japanese/Chinese/Korean.
- **Convert / Translate** can translate one subtitle file: pick From and To, drop the file, download. Format-only conversion is a separate tab.

### Fixed

- **distil-large-v3 is English-only.** Asking it for Japanese (or any non-English language) used to silently emit English subtitles. The backend now rejects that combo before the run.
- **large-v3-turbo 80 vs 128 mel mismatch.** A weights-only cache (no `preprocessor_config.json`) made faster-whisper default to 80 mel bins while the turbo encoder wants 128, crashing with `Invalid input features shape`. The loader now aligns the feature extractor to the encoder's `n_mels`.
- **Dashboard ⋯ Actions menu was clipped** by the queue table's overflow. The menu now portals to the document and opens above the row when there isn't room below.
- **Desktop sidebar footer was clipped** (queue/watcher/model/theme). The rail now fills the viewport and the status block stays pinned; nav links scroll if needed.
- **Preview showed empty translations while a job was still running.** It now reads the in-progress `.part` file and refreshes every few seconds.

## [0.5.8] — 2026-08-22

App-only release (the Whisper backend is unchanged; `whisper-v0.5.6` remains
current).

### Added

- **Translated Title Sidecar** (Settings → Translation Engine, default off).
  After each translation, the media filename's title — release tags stripped
  (`Inception.2010.1080p.BluRay.x264-SPARKS` → `Inception`) — is translated
  into the target language with the configured LLM and cached in a
  `.subsmelt_titles.json` sidecar next to the output. Cached titles are never
  re-translated (force re-translate refreshes them); jobs skipped because
  their subtitle already exists get a title backfill after the queue run.
  Translated titles appear on the language chips in Dashboard scan results
  and in the logs. Scans prune sidecar entries for media that no longer
  exists. Filenames on disk are never changed.

## [0.5.7] — 2026-08-21

App-only release (the Whisper backend is unchanged; `whisper-v0.5.6` remains
current).

### Added

- **File trees got a real redesign across every panel** (Transcribe library,
  Dashboard scan results, Settings media sources). Expand/collapse state now
  persists per folder in `localStorage` and survives refresh and reload —
  folders you have never opened start collapsed. Depth is readable at a glance:
  indentation plus vertical guide rails, sticky folder headers that stack two
  deep (deeper levels pin with an ancestor-path hint), and item counts on every
  folder row. On phones, deep nesting switches to drill-down navigation with a
  breadcrumb bar instead of unreadable indentation. Folder checkboxes select
  all descendants with a proper indeterminate state, and a text filter shows
  matches as a flat list labelled by relative path so hits from any depth are
  unambiguous.
- **The Subtitle Converter now detects each file's source language** from its
  first cues (in the browser, via `franc`) and shows it as a per-file badge,
  with an optional per-file override — no source dropdown to fill in. The
  target language is a free-text field that accepts BCP-47 codes ("zh-TW"),
  English names ("Japanese"), or native names ("繁體中文"), with autocomplete,
  typo suggestions, and recent-target chips. "Chinese" alone is never silently
  resolved — the field asks Simplified or Traditional. Output files are named
  with the canonical code (`video.zh-TW.srt`), each file converts
  independently with its own progress so one failure never aborts the batch,
  and files whose source already equals the target can be skipped inline.
- **Translation prompts now explicitly preserve formatting** — cue timing,
  line breaks, and inline tags (HTML-like, VTT voice tags, ASS/SSA override
  codes) are called out as untouchable, and Traditional Chinese targets are
  instructed to write native Taiwan-convention zh-TW rather than mechanically
  converted Simplified.

### Changed

- **The dashboard queue table's columns finally line up with their headers.**
  Header and rows are separate CSS grids, so the old `max-content` column
  tracks resolved differently in each — replaced with fixed tracks.
- **Row actions collapsed into one primary button plus a ⋯ menu** on both the
  desktop table and mobile cards (Re-translate, Logs, Details, and Delete live
  in the menu). Mobile cards lost three stacked full-width buttons each; the
  desktop table lost its orphaned "×" delete glyph.
- **"Whisper" is now "Transcribe" in the navigation and page title**, in all
  31 languages — the model name was jargon; the verb says what the page does.
- **Quieter dashboard**: zero-count stat tiles render muted instead of
  alarm-red "0", and zero-count bulk-action buttons are hidden instead of
  disabled. The Transcribe page uses the same sticky title bar as the
  Converter, scan actions collapse into a menu on phones, and the queue's
  Target column is a single muted line.
- **Large modules were split for maintainability** — the whisper page,
  dashboard panels, converter page, translator engine/utils, and the
  transcription server modules are now composed of focused files; no behavior
  change, all export paths preserved.

### Fixed

- **Path traversal in `/api/convert`**: a crafted `name` in the JSON body
  could escape the temp directory via `path.join`. Names are now stripped to
  their basename before any filesystem use, and language fields entering the
  LLM prompt are length-capped and sanitized.

## [0.5.6] — 2026-08-13

First public release.

### Added

- **The Whisper backend generates its own API key.** Every hardening message so
  far ended at "set `SUBSMELT_WHISPER_TOKEN`", which asks the operator to invent
  a secret — so in practice they picked a weak one or skipped it and left a
  `0.0.0.0`-bound backend open to the network. Now the backend hands one out:
  - **Control GUI:** a **Generate** button beside the API key field mints a
    256-bit key, reveals it, and copies it to the clipboard. **Copy** and
    **Show/Hide** sit next to it (the field is masked by default, so the window
    is safe to leave open while screen-sharing). Generating does not save or
    restart — press **Start**/**Restart** to apply, since rotating the key
    breaks every client still using the old one.
  - **Headless installs:** `run_server --generate-token` prints a key,
    `--save` writes it into `config.json`, and `--force` is required to replace
    a token already stored there. It warns when `SUBSMELT_WHISPER_TOKEN` is set
    in the environment, which takes precedence over the file.
  - **Service installer:** `install-service.ps1 -GenerateToken` mints one during
    install and prints it, delegating to the launcher so all three paths use the
    same generator.

  All of them name where the key goes: **Settings → Speech to Text → Backend
  token**.

### Fixed

- **Three dead paths in the Windows control window**, which between them made
  start-failure reporting silently absent:
  - `self.active` was initialised and cleared but never assigned, so the status
    line could only ever show a bare "● Running". It never named the bind
    address and port, never showed the **⚠ no token** warning for a backend
    open to the network, and never flagged edited fields as needing a restart.
  - `_await_ready` — the `/health` poll that catches a server dying *after* the
    two-second startup grace, which is the common case when CUDA probing runs
    long — was defined but never called. A backend that started and then failed
    to bind sat there reporting success.
  - Even once called, it could not have reported anything: it published through
    Tkinter's `after()` from a worker thread, which queues into that thread's
    Tcl apartment and is never serviced by the main loop. No exception, no
    callback, message discarded. Worker threads now hand text to the Tk thread
    through a queue that the window drains on its own timer.

  The status line, the readiness message, the late-failure message and the
  no-token warning all now reach the window. Covered by 17 new tests against
  the extracted pure helpers.

