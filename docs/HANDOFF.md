# SubSmelt — Handoff

Orientation for someone picking this project up. Current as of **0.6.7**
(2026-10-07). For what changed when, see
[../CHANGELOG.md](../CHANGELOG.md); for how to run it, see
[../README.md](../README.md).

---

## 1. What it is

A self-hosted service that watches a media directory, finds subtitle files, and
translates them into any number of target languages with an LLM. An optional
Python sidecar (the "Whisper backend") generates source subtitles from audio when
none exist.

Two deployables, versioned and released together:

| Deployable | Built from | Published as |
|---|---|---|
| SubSmelt app | `Dockerfile` (Node + React) | `ghcr.io/azuma24/subsmelt` |
| Whisper backend | `backend-whisper/` | Docker image, plus a Windows installer |

---

## 2. Layout

```
src/shared/          Types, the settings table and the charset detector both halves import
src/server/          Express API, queue, scanner, watcher, SQLite
  queue/             One job as stages (run-job), the live run's state, title sidecars
  translator/        LLM translation: engine, chunking, prompts; SRT/WebVTT and ASS parsers
  transcription/     Whisper backend client (HTTP, request building)
  routes/            HTTP route registration
src/client/          React SPA (Vite, Tailwind 4, react-query)
  features/          One directory per screen
  hooks/             Queries, mutations, the SSE stream, media queries
  i18n/              The translation runtime (t, plurals, lazy bundles) and its React hook
  ui/                The primitives kit (Button, Field, Layout, Status, Icon, …)
  lib/               Framework-free helpers (clipboard, error taxonomy, settings)
  locales/           32 translation bundles
backend-whisper/     FastAPI + faster-whisper sidecar
  app/               Endpoints, preflight, model management, GPU probing
  packaging/windows/ PyInstaller specs, Inno Setup installer, tray/GUI apps
```

### The parts worth understanding first

**`src/server/queue.ts`** — the job pump. Workers claim pending jobs from SQLite
(`claimPendingJob` is a single transaction, so concurrent workers cannot double
claim), resolve the LLM connection pool per job, and call `runJob` in
`queue/run-job.ts`, which runs one job as begin → plan (context probe) →
translate → settle, with the stop/cancel/failure settlement in one function.
`queue/state.ts` holds what the live run knows about its jobs (active ids,
abort controllers, cancels, connections) behind accessors. The worker pool
adapts to the configured LLM mode on every claim, so switching
single/fallback/parallel takes effect mid-run.

**`src/shared/settings.ts`** — the one table of every setting: kind (flag,
int, float, enum, json, text), bounds and default. The server's
`settings-schema.ts` builds a zod schema from it (`readSettings()` returns
typed values, falling back to the default for a bad stored value), the
settings route refuses a value that does not fit, and the Settings inputs carry
the same min/max.

**`src/server/translator/engine.ts`** — one file translation: parse → optional
context analysis (glossary extraction) → chunk → translate with cascade and
fallback → optional refinement pass → save. Two concerns are extracted and
tested:

- `connection-health.ts` — availability probing, the per-job timeout breaker
  (three transport failures and a connection is dropped for the rest of the job),
  and the acquire/release wrapper around the per-connection lock.
- `fallback-policy.ts` — the per-line fallback budgets. These numbers exist
  because a chunk failing on every connection used to walk every line at one full
  job timeout each.

**`src/server/connection-lock.ts`** — serialises requests per connection, with a
bounded wait. The bound is not cosmetic: a worker holds its primary connection
for a whole job while a cascading chunk needs another, so unbounded waiting
deadlocked two workers against each other.

**Output safety** — incremental saves go to `<output>.part` and are renamed onto
the real path only on completion. The queue treats an existing output file as
"already done", so a partial file at the real path would silently mark a job
finished. Interrupted jobs are reset to `pending` on startup and re-run from the
beginning; there is no mid-file resume. The job preview reads the `.part` file,
so a running translation shows its progress before it finishes.

---

## 3. Working on it

```bash
npm ci
npm run dev          # server (tsx watch) + vite, concurrently
npm test             # node:test over src/**/*.test.ts(x); 886 tests
npm run typecheck    # client AND server projects
npm run lint         # Biome (lint + format check), then the typechecks
npm run format       # rewrite the tree with Biome (biome.jsonc)
npm run build        # typecheck, then vite build, then tsc for the server

cd backend-whisper
pip install -r requirements.txt pytest ruff
python -m pytest tests -q          # must be run from backend-whisper/; 384 tests
ruff check . && ruff format --check .   # config in pyproject.toml
```

`git config blame.ignoreRevsFile .git-blame-ignore-revs` makes `git blame`
skip the one-off commit that formatted the whole tree.

Use Node 20 to 24 (`engines` in `package.json`). `better-sqlite3` is a native
module, so a shell on a newer Node, or on a different Node from the one that
ran the install, fails with `NODE_MODULE_VERSION` errors.

`npm ci` needs no flags any more. It used to need `--legacy-peer-deps` for
i18next's TypeScript peer range; i18next is gone, and the lockfile resolves
cleanly under npm 10's strict peer rules.

Client and server are separate TypeScript projects (`tsconfig.json` /
`tsconfig.server.json`) with no project reference between them — the client never
imports server code, and adding a reference forces `composite`, which the server
build cannot use. `npm run typecheck` checks both; **`vite build` does not
typecheck**, so do not treat a green build as a green typecheck.

### Render tests

`DashboardPage`, `SettingsPage`, `WhisperPage` and `ConvertPage` have
`*.test.tsx` files. `src/client/test-render.tsx` server-renders a page with
`react-dom/server` inside the same providers the app mounts, with query data
seeded in place of the API, and returns its text, headings, buttons and links.
No DOM library is involved. The limit is that a server render runs no effects
and no event handlers: it shows the first frame only. Settings copies its
server data into a form in an effect, so its tests see the empty form.
Anything behind a click needs a DOM-based test, which the repo does not have.

### CI and releases

`.github/workflows/ci.yml` runs Biome, the TypeScript suite, both typechecks,
the production build, ruff, pytest, and a Docker image build (no push) on every
PR and push to `main`. Both release workflows declare `needs: test`, so nothing publishes
without it. (CI was found switched off in GitHub's settings during 0.6.0, which is
why PRs had no checks; check `gh workflow list` if checks go missing.)

The Windows installer build pins every Python package to
`backend-whisper/packaging/windows/constraints.txt` (via `PIP_CONSTRAINT`), and
before an installer can be published it starts the frozen `run_server.exe`,
waits for `/health`, and transcribes a WAV with Whisper `tiny`. Each check exists
because 0.6.0's first installer broke past the old `--print-config` smoke test:
the spec never analysed the `app` package (a stdlib import went missing), and an
unpinned PyAV release broke Whisper decoding. Change a pinned version on purpose
and let those smoke tests prove it. The Mac cannot build the installer
(PyInstaller does not cross-compile; Inno Setup is Windows-only): dispatch the
workflow, or run `build-local.ps1` on a Windows machine.

Releasing is two tags on the same commit — full procedure, constraints and the
current release status in **[RELEASING.md](RELEASING.md)**:

```bash
# bump package.json, backend-whisper/app/version.py and
# backend-whisper/packaging/windows/installer.iss together
git tag -a v0.6.0 -m "SubSmelt 0.6.0" && git tag -a whisper-v0.6.0 -m "..."
git push origin v0.6.0 whisper-v0.6.0
```


`v*` publishes the Docker image; `whisper-v*` builds the Windows installer and
creates its GitHub release with the installer attached. The app's release notes
are written by hand afterwards. To fix an installer without a new version, build
the same version by dispatch and replace the asset with
`gh release upload whisper-v<ver> <exe> --clobber`, then say so in the release
notes (done once for 0.6.0). The installer is ~1 GB because the cuDNN and
cuBLAS wheels are bundled (703 MB + 528 MB compressed) — **no model weights are
included**; the model manager downloads those on first use.

---

## 4. New in 0.6.0

- **YouTube playlists** (`src/server/youtube/`, `src/client/features/youtube/`).
  `YoutubeStore` owns the video tables and refuses status moves the table in
  `video-status.ts` does not allow. `YoutubeWorker` runs two serial YouTube
  lanes under one cooldown: a video lane (downloads, caption fetches) and a
  metadata lane (listings, previews, exact-date lookups, one call per turn),
  so a check never waits behind an hour-long download. Then subtitles, translation
  jobs and the note export; `onSubtitlesComplete` is the only exit from
  `translating`. `gpu-gate.ts` holds translation while YouTube transcriptions
  are pending when `gpu_shared` is on. yt-dlp always runs through `ytdlp.ts`
  (argument array, own process group, `--js-runtimes node`); tests use
  `fake-yt-dlp.mjs`.
- **Nemotron 3.5 ASR** (`backend-whisper/app/catalog.py`, `nemotron*.py`). One
  model catalog with engine descriptors and a two-entry engine registry in
  `transcribe.py`. The engine shells out to the bundled `nemo-speech` 0.1.0,
  chunked at silences (max 720 s per chunk). The Windows CUDA build needs NVIDIA
  driver R580 or newer.

---

## 5. Known gaps

Nothing here is in progress. Ordered by what I would fix first.

### Security

- **SubSmelt has no authentication and binds `0.0.0.0`.** Anything on the LAN can
  drive the API, browse media paths, and change settings. Acceptable on a trusted
  network. The README says so; there is no optional token or auth mode.
- **The Whisper backend binds `0.0.0.0` by default** and only warns when no token
  is set (a loopback-only backend is unreachable from a
  container). The token has to be set on both sides: `SUBSMELT_WHISPER_TOKEN` on
  the backend and `WHISPER_BACKEND_TOKEN` (or the Settings field) on the app,
  otherwise every request 401s.
- **The Windows installer is unsigned**, so SmartScreen warns on every download.
  Needs a certificate.
- No rate limiting on either service.

### Correctness and coverage

- `backend-whisper/app/main.py` (883 lines, up from 816 at 0.5.6) and
  `backend-whisper/packaging/windows/tray/whisper_gui.py` (858) exceed the
  800-line guideline. They are the only source files that do. `WhisperPage.tsx`
  is down from 840 to 496 lines.
- **Stopped jobs cannot resume from their `.part` file.** The file stores
  `translatedText || text`, so a translated cue cannot be told apart from an
  untranslated one. Resuming needs either "translation equals source" to count
  as untranslated, or a sidecar list of translated cue indices. Not decided.
- **Installs that stored the redaction marker as their API key** must re-enter
  the key once. No migration was written.
- The CI runner has no `ffmpeg`, so the backend's ffmpeg paths are only exercised
  by tests that mock it (the Windows build's smoke test does use the bundled
  `ffmpeg.exe`).
- **The Linux backend Docker image is not locked** the way the Windows installer
  is; only the packages in `requirements.txt` are pinned.
- **GPU paths are tested only on real hardware.** CI has no GPU; Whisper on CUDA
  (cuDNN 9.27) and Nemotron on CUDA were verified on the maintainer's RTX PRO 6000
  for 0.6.0. The Windows `nemo-speech` build needs NVIDIA driver R580 or newer.
- **Render tests cover four screens, first frame only** (see §3). `shell`,
  `LogsPage`, `TasksPage` and `JobDetailPage` have none, and no test clicks
  anything.

### Product

First run is *signposting*, not a wizard: Settings shows what is outstanding and
Activity has a checklist, but nothing walks a new operator through the ~65
settings.

The Whisper control window still lacks the model manager and diagnostics the
tray app has. It can now tail the log in-window ("View log"), resolving
the path with `run_server`'s own precedence.

---

## 6. Document status

| Document | Status |
|---|---|
| [../README.md](../README.md), [../CHANGELOG.md](../CHANGELOG.md), this file | Current |
| [TODO.md](TODO.md) | Current — open items only |
| [why-llm-translation.md](why-llm-translation.md) | Current — explainer for users |
| [RELEASING.md](RELEASING.md) | **Current** — release procedure and tag-push constraints |
## 7. Session handoff — 2026-10-06

What a session on this machine left behind, and where each piece lives.

**Remotes** — during this session, **both** `forgejo/main` and `origin/main`
were force-updated to the same **squashed snapshot** (`50d9109 SubSmelt 0.6.6`
+ a docs commit, no shared history with the pre-squash line). So the squash
publish is the established flow, and it happened on both remotes at once.
`main` here continues that snapshot **linearly** (today's commits are
descendants of `50d9109`), so pushing it to either remote is a normal
fast-forward — no force, nothing rewritten. The detailed pre-squash history is
preserved locally in branch `pre-squash-history` (and the worktree branch
`feat/library-page` sits on that same older base); drop both only when the
squash flow has fully replaced them. The stale whisper WIP this checkout
carried was an earlier draft of work already finished in the squashed state
(`fold_iso3`, the snap-guard fix, tests inside the class) — it is stashed
(`git stash list`), not deleted, and safe to drop.

**This session's work (all committed on `main`):**

- **Library sort controls** — the Library page lost its sort when the old scan
  tab died; it is back (`buildLibraryView` takes `sortBy`/`sortDir`; items sort
  by name or date, folder sections by name or newest file, undated last). The
  controls are shared components (`src/client/ui/SortControls.tsx`,
  `RefreshButton.tsx`) rendered by both the Library page and the Transcribe
  picker; the sort preference persists to `transcription_sort_by` /
  `transcription_sort_dir`, which both pages read.
- **"Renaming the LLM breaks the running translation"** — investigated and
  **not reproducible on 0.6.x**: every path (panel rename with preserved id,
  redacted-key round-trip, mid-run rename, full `POST /api/settings`) keeps the
  API key and the running job's connection snapshot. The historical bug was
  real but fixed in `4c6a880` (pre-0.6.0 flat-key installs saved the redaction
  marker as the key). Regression suite: `src/server/rename-midrun.test.ts`.
  If a pre-0.6.0 install still shows it, updating fixes it.

**State:** `main` == squashed 0.6.6 + this session's three commits; both
`backend-whisper` (383 tests) and the TS suite (882 tests) pass, `typecheck`
clean. Push to both remotes is a fast-forward.

## 8. Session handoff — 2026-10-06 (modernisation)

One branch, `claude/modernize-and-refactor`, one commit per change. What a
reader of the code should know afterwards:

- **Every dependency is on its current major**: React 19, Express 5 (routes use
  `/{*splat}`, `req.body` can be undefined so a middleware sets `{}`), Vite 8
  on Rolldown (`build.rolldownOptions.output.advancedChunks` splits React and
  the vendor libraries), Tailwind 4 (CSS-first: the palette and the role
  tokens live in `src/client/index.css` under `@theme`; there is no
  `tailwind.config`), AI SDK 7, zod 4 (the SDK's required peer), chokidar 5.
  `@types/node` stays at 22 on purpose, matching the runtime. `npm ci` needs
  no flags: the peer-range conflict went with i18next.
- **What is the app's own code now, and was a package:** SRT/WebVTT and ASS
  parsing (`src/server/translator/srt-vtt.ts`, `ass.ts`), charset detection
  for files that are not UTF-8 (`src/shared/charset.ts`: strict UTF-8 first,
  then every candidate encoding decodes a sample and the one that reads as
  text in its own script wins; `charset.fixtures.ts` holds 52 byte samples),
  the converter's ZIP writer (`src/client/features/convert/zip.ts`, deflate
  through CompressionStream), the translation runtime (`src/client/i18n/`:
  plural suffixes from Intl.PluralRules, `_zero` first for zero, fallback to
  the base language then English, the stored choice under the old
  `i18nextLng` key), the dev runner (`scripts/dev.mjs`) and the scan's
  concurrency pool (`src/server/async-pool.ts`). The client project names
  the Node typings its tests need in `tsconfig.json`; nothing pulls them in
  transitively any more.
- **Biome** (`biome.jsonc`) lints and formats the TypeScript; three a11y rules
  are off with the reason beside each. **ruff** (`backend-whisper/pyproject.toml`)
  does the same for Python. CI runs both.
- **`src/shared/`** is the API contract. Add a type there when both sides
  need it; `src/client/types.ts` re-exports under the client's names.
- **Client structure:** `hooks/` (queries, mutations, SSE, media queries;
  `useIsMobile` comes from a context the shell provides, so no page passes
  `isMobile` down), `ui/` (every primitive, `primitives.ts` is the barrel),
  `lib/` (framework-free). `PageHeader` is the one header; `Select`,
  `TextArea`, `IconButton` and `Toggle` are the kit's controls.
- **Polling backs off while the SSE stream is open** (`useSsePollInterval`);
  the stream's invalidation map in `hooks/sse.ts` is what keeps the pages
  current, so a new event kind must be added there.
- **Not done, on purpose:** authentication, a bind change beyond `HOST`, and
  rate limiting — see TODO.md.
