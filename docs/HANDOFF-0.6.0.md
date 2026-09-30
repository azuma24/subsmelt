# Handoff: finishing SubSmelt 0.6.0

Written 2026-09-30 for the next agent. Read this file top to bottom before you touch code. It tells you what is done, what is left, in what order, how to verify each piece, and which traps already cost time.

## 1. Where things stand

### Done and pushed (branches exist on both remotes)

| Branch | Contents | PRs |
|---|---|---|
| `chore/pre-0.6-wip` | Work that was uncommitted before this cycle (media-paths extraction, progress-write throttle, scan transcription cap, fetch_url SSRF guard) | GitHub #2, Forgejo #1 (base `main`) |
| `fix/dashboard-clear-finished` | "Clear finished" keeps running and pending jobs; phone header shows all three scan/run actions | GitHub #3, Forgejo #2 (base `chore/pre-0.6-wip`) |
| `fix/server-audit-0.6.0` | 26 server bug fixes | GitHub #4, Forgejo #3 (base `fix/dashboard-clear-finished`) |
| `fix/client-audit-layout-0.6.0` | 23 client bug fixes, 8 layout fixes | GitHub #5, Forgejo #4 (same base) |
| `fix/whisper-backend-audit-0.6.0` | 14 Whisper backend fixes | GitHub #6, Forgejo #5 (same base) |
| `release/0.6.0` | Integration branch: all of the above merged, plus this handoff, the YouTube PRD and the CHANGELOG draft | none yet |

`release/0.6.0` is the base for all remaining work. On it: `npm test` 473 pass, `npm run typecheck` clean, backend `pytest tests` 291 pass. All eight Codex review findings on PRs #2 and #4 to #6 are answered and resolved on GitHub; four were fixed (1fb89eb, f093611, 5528dda) and merged here. The shared contracts between the server and client fixes were checked live (saved-connection key reuse only for the saved endpoint; comma folder names scan).

### Not done — task checklist

The goal is a full 0.6.0 where the app and the Whisper backend ship at the same version. This list is every task that is not complete as of 2026-09-30. Implementation detail for each item is in section 4. Groups A and B touch different areas and can be worked in either order; C and D close the release.

**A. YouTube (5 stacked PRs)**

- [ ] **A1** `feat/youtube-runtime` (PR 1). `urls.ts` and the Dockerfile stages exist. Still to write `ytdlp.ts` (binary resolution, arg-array spawn, `classifyYtdlpError`, `downloadArgs` with `--js-runtimes node`, `ytdlpVersion`, `updateYtdlp`), `fake-yt-dlp.mjs`, and routes `GET /api/youtube/status` plus `POST /api/youtube/ytdlp/update`. Re-verify the image on arm64 and amd64 with the smoke script and a real in-container download (§4.1).
- [ ] **A2** `feat/youtube-follow` (PR 2). `store.ts` (`YoutubeStore`), `video-status.ts`, the `playlists.ts` setting, the sync step, `backfill.ts`, `data-api.ts`, the playlist routes and `POST /api/youtube/api-key/test`, the `/youtube` client page with follow dialog and Settings section, and `nav.youtube` in 32 locales. Live check, follow the user's Unlisted playlist with backfill None (§4.2).
- [ ] **A3** `feat/youtube-download` (PR 3). Serial download lane, per-video temp dir, progress over SSE, auto and manual modes, Skip and Retry, cooldown, boot reconciliation, cookies upload. Tests from a fake yt-dlp; live check of at most 3 short videos (§4.3).
- [ ] **A4** `feat/youtube-subtitles` (PR 4). `subtitle-routes.ts` with `planSubtitles`, creator captions through `runTranscriptionAttempt`, job creation for translation, the scanner skip, and `gpu-gate.ts` with the `gpu_shared` setting and the hold at 20 waiting subtitles (§4.4).
- [ ] **A5** `feat/youtube-notes` (PR 5). `note.ts` with a golden-file test, the `youtube_notes_dir` setting, temp-file rename export, and the `youtube:note` webhook (§4.5).

**B. Nemotron 3.5 ASR (`feat/nemotron-asr`)**

- [ ] Follow `docs/handoff-0.6.0/nemotron-engine-brief.md`. Engine registry and descriptors under model id `nemotron-3.5-asr`, GGUF download via `allow_patterns`, binary resolution, word-to-segment building, the locale table, reuse of the backend `lease`, Windows and Docker packaging, the server and client changes, and 32 locales (§4.6).
- [ ] End to end on the Mac against the real binary, and record the timing.

**C. Compatible backend release (same version as the app)**

- [ ] Bump all three version files together to `0.6.0`. They are all still `0.5.9`: `package.json`, `backend-whisper/app/version.py` (`_DEFAULT_VERSION`) and `backend-whisper/packaging/windows/installer.iss` (`#define MyAppVersion`).
- [ ] Rebuild the Windows installer by tagging `whisper-v0.6.0`, and confirm the workflow publishes `SubSmeltWhisperBackend-Setup-0.6.0.exe`. The newest installer is `whisper-v0.5.9` at 1.08 GB and is unsigned.
- [ ] Publish the Docker image via `v0.6.0`, including `latest`, and confirm the backend image too.
- [ ] Confirm the backend `/health` version equals the app version.

**D. Release 0.6.0**

- [ ] Merge every finished branch into `release/0.6.0` with `--no-ff`, then re-run all checks on the merge tip.
- [ ] Finish `CHANGELOG.md`. Turn `[Unreleased]` into `## [0.6.0] - <date>`, add YouTube and Nemotron under Added, and drop anything that did not land.
- [ ] **Stop and ask the user** before merging to `main` and pushing tags.
- [ ] After the go, fast-forward `main`, push `main` and push it to Forgejo, tag `v0.6.0` and `whisper-v0.6.0` on the same commit, push both tags, and verify with `git ls-remote --tags origin`.
- [ ] Write the GitHub release notes by hand.

**E. Verification and hygiene**

- [ ] Get CI green on the branches. No 0.6.0 commit has run through GitHub Actions yet. The last run is 2026-09-09 on `main`, and all six open PRs have empty checks. Local gates on `release/0.6.0` (`53325e0`) were green on 2026-09-30, with 473 node tests, 291 pytest, typecheck, build and Docker build.
- [ ] Refresh `docs/HANDOFF.md`, which still says "Current as of 0.5.6".
- [ ] Fix `docs/TODO.md` drift. The `WhisperPage.tsx` 840-line item is done (now 496 on `release/0.6.0`), while `backend-whisper/app/main.py` has grown to 892, up from the 816 the TODO claims.
- [ ] Translate the 31 non-English locales' `errors.*` values. 536 of 620 are still byte-identical to English.
- [ ] Add render tests for at least the Dashboard, Settings, Whisper and Convert screens. There are zero `*.test.tsx` files today.

**F. Checks only the user can run**

- [ ] Windows CUDA backend. Transcribe with `large-v3` then `small` and watch `nvidia-smi`; delete a model while idle and confirm its folder is removed; set `SUBSMELT_FFMPEG` with no ffmpeg on PATH and confirm `/health` reports `ffmpeg: true`; cancel a streaming transcription and confirm `%TEMP%\subsmelt-upload-*` disappears.
- [ ] Docker host `192.168.1.110`. After YouTube lands, follow the AI playlist with backfill None, add one video, press Check now, and confirm download, subtitles, translation and a note in `/notes`.

**G. Open questions for the user**

- [ ] Resuming stopped jobs from `.part` files. Treat "translation equals source" as untranslated, or add a sidecar list of translated cue indices.
- [ ] Installs that stored the redaction marker as their API key must re-enter the key once, or a migration must be written.

Remotes: `origin` is GitHub `azuma24/subsmelt`; `forgejo` is `ssh://git@192.168.1.110:2222/claude-agent/subsmelt.git` (web UI and API at `http://192.168.1.110:4000`, HTTP only). The user wants every PR opened on both. `gh` works for GitHub. For Forgejo, the `fj` CLI fails because it forces HTTPS; use the REST API with the token stored in `~/Library/Application Support/forgejo-cli.forgejo-cli/keys.json` (`hosts."192.168.1.110:4000".token`). Never print the token. Example body: `POST http://192.168.1.110:4000/api/v1/repos/claude-agent/subsmelt/pulls` with `{"head","base","title","body"}` and header `Authorization: token <token>`.

## 2. Decisions already made (do not reopen)

All recorded in `docs/PRD-youtube-playlists.md` section 4 and in the user's memory. The ones that change code:

- No YouTube login or OAuth. Playlists are shared as Unlisted links; cookies.txt only for Private playlists. An optional YouTube Data API key (in Settings, YouTube section, with a Test button) enables the "Added since" backfill filter.
- Build YouTube inside SubSmelt. Copy ideas from TubeSync, never its code (AGPL).
- Per playlist: Audio or Video; video quality, codec, container; audio m4a or opus (no mp3).
- **Subtitle languages:** the user picks the languages they want. Nothing assumes English. Per video and per picked language: the transcript when the video is already in that language; creator captions when YouTube has them in that language; otherwise transcribe then translate. The YouTube worker creates its own jobs; the scanner skips the YouTube download folder.
- Backfill filter: All, None, Posted since (year and month picker), Added since (needs the API key).
- Removed videos keep their files. Notes go to a `/notes` mount, one note per video, one section per language, wikilinks for channel and playlist, `youtube:note` webhook when a note is ready. No length filters.
- Whisper and the LLM share one GPU: batch mode (`gpu_shared` setting), cap at 20 subtitles waiting.
- Only one new transcription model: **Nemotron 3.5 ASR**. No Nemotron diarization; pyannote stays.
- SubSmelt is LAN-only; no login is added for 0.6.0.

## 3. How to work in this repo

### Setup and checks

- **Use Node 22.** The installed better-sqlite3 is built for Node 22 and the default `node` on this Mac is v26, which cannot load it. Run `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` in every shell before `npm` or `npx`.
- App checks: `npm test` and `npm run typecheck`. Build check: `npm run build`. Fresh installs need `npm ci --legacy-peer-deps`.
- Backend checks: from `backend-whisper/`, `python -m pytest tests -q` in a venv with `requirements.txt` + `pytest`. CI uses Python 3.13 and only those packages, so tests must skip cleanly when optional packages (faster-whisper, torch, pyannote, yt-dlp) are missing.
- Work in a separate git worktree per branch: `git worktree add -b <branch> <path> release/0.6.0`, then `ln -s /Users/richard/Projects/subsmelt/node_modules <path>/node_modules`. Do not use the Agent tool's automatic worktree isolation: it branched from `main` instead of the intended commit last time.
- **Never touch the user's real `./config` or `./data`.** For live checks run the server with scratch folders: `DATA_DIR=<tmp>/data CONFIG_DIR=<tmp>/config MEDIA_DIR=<tmp>/media PORT=<port> npx tsx src/server/index.ts`. Port 3000 on this Mac is the user's own running instance; do not use it. `vite.dev-alt.config.ts` serves the client on 5174 and proxies to 3100.
- Seed jobs of every status with `docs/handoff-0.6.0/seed-jobs.mts <DATA_DIR>`.

### Screenshots

`docs/handoff-0.6.0/shoot.cjs` drives the Chrome for Testing that Playwright installed at `~/Library/Caches/ms-playwright/chromium-1208`, through the Playwright core bundled with gstack (`~/.claude/skills/gstack/node_modules/playwright-core`). Run it with Node 22: `node shoot.cjs <outdir>`. It captures every page at 390x844 and 1280x800 from `http://localhost:5174`. Wait for `load` plus a delay; `networkidle` never fires because the app keeps a Server-Sent Events connection open. Always open and look at the PNGs before calling a UI change done.

### Conventions the tests enforce

- Every new or changed user-facing string goes into all 32 locale files (`src/client/locales/*/translation.json`) in the same commit, with real translations. `locale-coverage.test.ts` checks key parity and `{{placeholder}}` sets.
- Some tests read source files with regular expressions (`src/client/layout-readability.test.ts`, `src/client/features/tasks/translation-defaults.test.ts`). If you change a pinned class name on purpose, update the assertion to the new intent.
- Styling: CSS tokens from `src/client/index.css` only (`var(--accent)` and friends), `text-[var(--on-accent)]` on solid fills, no opacity suffix on `var()` colors, 44 px minimum hit targets, one primary action per screen, every status shows a glyph or text as well as a color. Reuse `src/client/ui/primitives.tsx`.
- Server response shape is plain JSON with `{ error }` on failure (the repo convention, not an envelope).
- Commits: conventional commits (`feat(youtube): ...`, `fix(server): ...`), small units, each one green. No co-author or session trailers.
- Comments only for a non-obvious reason.

## 4. Remaining work, in order

Do 4.1 to 4.5 (YouTube) and 4.6 (Nemotron) in either order; they touch different areas except the locale files and `src/server/config.ts`, where you will need to merge by hand. Then 4.7 (release).

For every PR: open it on GitHub and Forgejo with base `release/0.6.0` (or the previous stacked branch), a summary written for the user, and a test plan with checked boxes for what you ran and unchecked boxes for what only the user can run.

### 4.1 YouTube PR 1: runtime (branch `feat/youtube-runtime`)

State: the Dockerfile stages, `scripts/youtube-smoke.sh` and `urls.ts` are committed on this branch. The pinned checksums match the official files (yt-dlp 2026.08.19 `SHA2-256SUMS`; ffmpeg 7.1.2 tarball). Verified at handoff on arm64: `docker build` succeeds, `yt-dlp --version` prints 2026.08.19, `ffmpeg -version` prints 7.1.2, the smoke script lists `playlist_count 2384` with 3 entries, and the whole image is 391 MB on disk. Not yet checked: an amd64 build and a real download inside the container. Everything below step 1 is still to do.

To do:
1. Verify the image again after your changes, and once on amd64 if you can: `docker run --rm --entrypoint sh subsmelt:yt-test -c 'yt-dlp --version && ffmpeg -version | head -1 && scripts/youtube-smoke.sh "https://www.youtube.com/playlist?list=UUsooa4yRKGN_zEE8iknghZA" --playlist-end 3'`. Expect `playlist_count 2384` or more and three entries. Measure the size added (`du -sxm /` inside the new image against an image built from `release/0.6.0`); the prototype measured about 45 MB.
2. **Done** (commit `8c19e10` on `feat/youtube-runtime`, 474 tests pass): `src/server/youtube/urls.ts`: parse pasted URLs into a playlist list ID (accept `youtube.com/playlist?list=`, `watch?v=...&list=`, `youtu.be`, `music.youtube.com`, extra params such as `si=`); build canonical URLs; validate IDs (list `^[A-Za-z0-9_-]{10,64}$`, video `^[A-Za-z0-9_-]{11}$`). Tests with literal inputs and outputs.
3. `src/server/youtube/ytdlp.ts`:
   - Resolve the binary: `SUBSMELT_YTDLP_BIN`, then `${DATA_DIR}/bin/yt-dlp`, then `/usr/local/bin/yt-dlp`, then PATH.
   - Spawn with an argument array only, never a shell, under a timeout.
   - `classifyYtdlpError(stderr)` (classes in PRD section 7).
   - `downloadArgs(profile)`. Always include `--js-runtimes node`.
   - `ytdlpVersion()`.
   - `updateYtdlp()`: copy the image binary to `${DATA_DIR}/bin/yt-dlp` if missing, then run `-U`.
   Two findings from a partial attempt: yt-dlp prints both `Video unavailable` and `This video is unavailable`, so `classifyYtdlpError` must match both. And when `SUBSMELT_YTDLP_BIN` is set, `updateYtdlp()` should run `-U` on that binary in place instead of copying, otherwise a test run could pick up a system yt-dlp and update it over the network.
4. `src/server/youtube/fake-yt-dlp.mjs`: a fake binary for tests that replays canned JSON, progress lines and stderr chosen by environment variables.
5. Routes in `src/server/routes/youtube.ts`, registered from `index.ts`: `GET /api/youtube/status` returning `{ytdlp:{available,version,path}, ffmpeg:{available,version}}`, and `POST /api/youtube/ytdlp/update`.

Facts you can rely on (measured, PRD Appendix B):
- yt-dlp needs `--js-runtimes node`; without it YouTube formats may be missing.
- A flat listing of the user's Unlisted playlist works without cookies and reports `playlist_count` equal to the entry count. 7 entries are private or deleted, with no title and no duration.
- yt-dlp's default sort already prefers the original audio track over AI dubs; keep `lang` first in `-S` anyway.
- `-S res:<h>,vcodec:h264,acodec:aac --merge-output-format mp4` and `-x --audio-format m4a|opus` work with the minimal ffmpeg, as does `--convert-subs srt`.

### 4.2 YouTube PR 2: follow and sync (branch `feat/youtube-follow` from 4.1)

Build, following PRD sections 5, 6 (step 1), 10, 11:
- **`store.ts`:** a `YoutubeStore` class taking a better-sqlite3 `Database` in its constructor, so tests can use `:memory:`. It owns the `youtube_videos`, `youtube_playlist_items` and `youtube_sync_state` tables.
- **`video-status.ts`:** the status enum and transition table. The store refuses illegal transitions.
- **`playlists.ts`:** the `youtube_playlists` JSON setting, with a default in `config.ts`. Settings keys without a default are rejected on save.
- **Sync step:** a flat listing, then upsert of every entry. Removal is marked only when the entry count equals `playlist_count`. Entries with no title and no duration become `unavailable`.
- **`backfill.ts`:** the four filters. "Posted since" asks for an exact `upload_date` (one metadata call per video) only for videos whose rounded date sits near the cutoff.
- **`data-api.ts`:** reads added dates with the optional `youtube_api_key`, using plain `fetch` and paging on `nextPageToken`. The key goes into `SECRET_SETTING_KEYS` so it is redacted.
- **Routes:** the playlist routes and `POST /api/youtube/api-key/test` from PRD section 10.
- **Client:**
  - A `/youtube` nav item: the mobile overflow group, a lazy route, and `nav.youtube` in 32 locales. The selected playlist lives in `?playlist=<id>`, because nav highlighting uses exact path matches.
  - The YouTube page: playlist list, playlist detail, empty state, and banners.
  - The follow dialog.
  - The Settings YouTube section.
  - Match the approved mockup, `docs/handoff-0.6.0/youtube-tab-mockup.html`. Open it in a browser to see it. Copy its structure, states and wording, but build with the app's own components.
- **Checks:**
  - Follow the user's Unlisted playlist `https://www.youtube.com/playlist?list=PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8` with backfill **None**, and see its videos appear.
  - Never run a full backfill: it has about 890 videos and 375 hours.

### 4.3 YouTube PR 3: download (branch `feat/youtube-download`)

Build PRD sections 6 (step 2, crash safety), 7 and 12:
- **Download step:** one serial YouTube lane with a per-video temp dir under `${DATA_DIR}/youtube/tmp`. Progress goes out as `youtube:video` SSE events.
- **Modes:** auto and manual.
- **User actions:** Skip and Retry.
- **Cooldown:** after a rate limit or bot check, the lane pauses for 1 hour, doubling up to 24 hours. It is stored in `youtube_sync_state` and announced with `youtube:cooldown`.
- **Boot reconciliation:** clear the temp dir; move `downloading` back to `queued`; if a queued video's file already exists, skip its download.
- **Cookies:** upload as JSON text to `${DATA_DIR}/youtube/cookies.txt` with mode 0600. Give yt-dlp a copy for each run, and never return the file from the API.
- **Tests:** a fake-yt-dlp worker test per path (success, 429 into cooldown, crash at each step converging after restart).
- **Live check:** download at most 3 short videos in total, for example `qD0_yWgifDM` (3 min 54 s).

### 4.4 YouTube PR 4: subtitles, translation, GPU gate (branch `feat/youtube-subtitles`)

Build PRD section 6 (steps 3 to 5, the GPU section):
- **`subtitle-routes.ts`:** pure `planSubtitles(spokenLang, tasks, creatorCaptionLangs)` plus one language-code normalising table. Tests cover each route and each code pair (`zh-TW` against `zh-Hant`, `en` against `eng`).
- **Transcription:** through the existing `runTranscriptionAttempt` (`src/server/routes/transcription-runtime.ts`). Creator captions come from `--skip-download --write-subs --sub-langs <lang> --convert-subs srt`.
- **Translation:** create jobs directly with `createJob` for the languages that need translating.
- **Scanner:** skips the YouTube download folder.
- **`gpu-gate.ts`, `gpu_shared` setting and STT toggle:**
  - `processQueue()` asks the gate before starting.
  - Translation is held while YouTube transcriptions are pending, unless 20 subtitles are already waiting.
  - A cooldown releases the hold.
- **Live check:** no Whisper backend or LLM runs on this Mac, so write two small stubs:
  - a fake backend implementing the endpoints in `src/server/transcription/http-*.ts`, returning an SRT;
  - a fake OpenAI-compatible LLM returning translations.

### 4.5 YouTube PR 5: notes (branch `feat/youtube-notes`)

Build PRD section 9:
- **`note.ts`:** `renderNote(info, cues, translations)` with a golden-file test.
  - Frontmatter uses wikilinks for channel and playlist.
  - Cues merge into paragraphs that break at chapter starts or after 45 s at a sentence end.
  - Each paragraph has a timestamp link.
  - One section per language.
  - Filenames avoid `[ ] # ^ |`.
- **Notes folder:** the `youtube_notes_dir` setting defaults to `/notes` and shows its mount status in Settings.
- **Export:** writes go through a temp file and rename; a re-export overwrites the note.
- **Webhook:** a `youtube:note` event with a summary line in `src/server/notify.ts`, and a choice in the notification settings.

### 4.6 Nemotron 3.5 ASR (branch `feat/nemotron-asr` from `release/0.6.0`)

Follow `docs/handoff-0.6.0/nemotron-engine-brief.md` exactly. Key facts:

**Runtime**
- NeMo-Speech.cpp v0.1.0 runs the model natively from `nemotron-3.5-asr-streaming-0.6b.q8_0.gguf` (742 MB, HF repo `nvidia/nemotron-3.5-asr-streaming-0.6b`).
- Release assets include `windows-x86_64-cuda.zip`, `linux-x86_64-cuda.tar.gz`, `linux-aarch64-cpu.tar.gz` and `macos-aarch64-metal.tar.gz`, each with a `.sha256`.
- The scratch paths in the brief may no longer exist. Re-download the Mac build and the GGUF if you need them; they are public.

**CLI behaviour (measured)**
- `nemo-speech transcribe <wav> --model <gguf> --language <locale|auto> --json` prints one JSON object at the end: `{file, text, confidence, duration, languages, words:[{word,start,end,confidence}]}`.
- There is no progress output, even with `--stream`. Hence the design: split long audio at silences into chunks of about 10 minutes, one subprocess per chunk, progress per chunk, cancel by killing the process.
- On an M-series Mac with Metal, 234 s of audio took 20 s including model load.

**Build**
- An engine registry and model descriptors. The model id is `nemotron-3.5-asr`, with no slash, because the Node server rejects `/` in model names.
- Keep `capabilities.models: string[]` for old clients and add `capabilities.modelInfo`.
- Download only the GGUF with `huggingface_hub` `allow_patterns`.
- Resolve the binary from `SUBSMELT_NEMO_SPEECH`, then a copy bundled next to the executable, then PATH.
- Build subtitle segments from words, measuring length in characters for CJK text.
- One table maps short codes to Nemotron locales.
- Build on the backend's single-resident-model `lease` in `app/model_loader.py`; do not rewrite it.
- **Packaging:** Windows files are `packaging/windows/build-local.ps1`, the PyInstaller spec, the Inno Setup script, `install-service.ps1` (set `SUBSMELT_NEMO_SPEECH`) and `.github/workflows/windows-whisper-build.yml`. Docker is `backend-whisper/Dockerfile`. Pin versions and verify checksums.
- **Server:** the low-RAM downgrade must not switch engines (`http-health.ts`); history retry reuses the stored model; the history scrubber must not mangle model ids.
- **Client:**
  - Group models under "Whisper" and "NVIDIA Nemotron", with a one-line strength each.
  - Hide options the model does not support.
  - Rename "Whisper Models" to "Speech-to-text models".
  - Add all strings to 32 locales.

**Check**
- End to end on the Mac: transcribe a short English file with the real binary, compare against YouTube captions, and record the timing.
- List the Windows checks for the user.

### 4.7 Release 0.6.0

Follow `docs/RELEASING.md`, on `release/0.6.0` after every feature branch is merged into it:
1. Merge each finished branch with `--no-ff`, then run all checks (`npm run typecheck`, `npm test`, `npm run build`, backend `pytest`).
2. Bump the three version files together to `0.6.0`: `package.json`, `backend-whisper/app/version.py` (`_DEFAULT_VERSION`), and `backend-whisper/packaging/windows/installer.iss` (`#define MyAppVersion`).
3. Finish `CHANGELOG.md`. The `[Unreleased]` section already lists all fixes; add YouTube and Nemotron under Added, and turn `[Unreleased]` into `## [0.6.0] — <date>`. If a feature did not land, leave it out and say so in the user report.
4. **Stop and ask the user** before merging into `main` and pushing tags. The tags `v0.6.0` and `whisper-v0.6.0` publish the Docker image (including `latest`) and the Windows installer; that cannot be quietly undone.
5. After the go: fast-forward `main` to the release commit (or merge), push `main`, then `git tag -a v0.6.0 -m "SubSmelt 0.6.0"` and `git tag -a whisper-v0.6.0 -m "SubSmelt Whisper backend 0.6.0"` on the same commit, and push both tags to `origin`. Also push `main` to `forgejo`. Check `git ls-remote --tags origin` afterwards; tag pushes can be rejected by protection rules.
6. Write the app's GitHub release notes by hand from the CHANGELOG section.

If time is short, a smaller 0.6.0 is a valid choice **only if the user agrees**: ship the fixes (already merged) and whichever features are complete, and move the rest to 0.7.0. Ask before cutting scope.

## 5. Open questions for the user

From the server fixes (PR #4):
1. **Resuming stopped jobs from `.part` files** is deferred. The file stores `translatedText || text`, so a translated cue cannot be told apart from a passthrough. Options: treat "translation equals source" as not translated, or add a sidecar list of translated cue indices.
2. Installs that stored the redaction marker as their API key must re-enter the key once. No migration was written.

## 6. Manual checks only the user can do

On the Windows CUDA backend (after installing the 0.6.0 Whisper backend):
- Transcribe with `large-v3`, then with `small`; `nvidia-smi` memory should drop to about the small model's size. Delete a model while idle and confirm its folder is removed.
- With `SUBSMELT_FFMPEG` set and no ffmpeg on PATH, `GET /health` reports `ffmpeg: true`.
- Cancel a streaming transcription; `%TEMP%\subsmelt-upload-*` should disappear within seconds.
- After Nemotron lands: download "Nemotron 3.5 ASR" in Settings, transcribe a file, and note the speed.

On the Docker deployment (192.168.1.110):
- After YouTube lands: follow the Unlisted AI playlist with backfill None, add one new video to the playlist, press Check now, and confirm it downloads, gets subtitles, translates and writes a note in the mounted `/notes` folder.

## 7. Traps that already cost time

- `better-sqlite3` fails under Node 26 with `NODE_MODULE_VERSION` errors; use Node 22.
- Playwright `networkidle` hangs because of the SSE connection.
- In standalone HTML, a class with `display: grid` overrides the `hidden` attribute; add `[hidden]{display:none!important}`.
- Worktrees created by the Agent tool's automatic isolation start from `main`, not from your branch.
- The NeMo-Speech v0.1.0 release cannot load Nemotron-3-Diarization (`pre_ln transformer variant is not supported`). That model is out of scope anyway.
- Building NeMo-Speech from source on this Mac needs Ninja, `CMAKE_POLICY_VERSION_MINIMUM=3.5`, `scripts/build_sentencepiece_static.sh` and `-DCMAKE_PREFIX_PATH=<repo>/.deps/sentencepiece`. You should not need it for Nemotron ASR; the v0.1.0 release works.
- Do not publish, tag or merge to `main` without the user's go.
