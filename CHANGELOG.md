# Changelog

All notable changes to SubSmelt. The app and the Windows Whisper backend share a
version number and are released together (`v0.5.2` and `whisper-v0.5.2`).

## [Unreleased]

### Fixed

- **Whisper control window (Windows).** It reported "started" as soon as `Popen`
  returned, so a server that could not bind — usually a port conflict with the
  installed service — looked like a success; it now waits briefly and reports the
  exit code and the likely cause. Status is polled every 3s instead of only on a
  button press, so a crashed backend no longer reads as "● Running". Host, port
  and token persist to `config.json` (which `run_server` reads on every start, so
  they apply to the service too) instead of being session-only, and a wide bind
  with no token is called out both at start and in the status line.

## [0.5.3] — 2026-08-04

### Added

- `WHISPER_BACKEND_TOKEN` seeds the STT backend token from the environment.
  Arming `SUBSMELT_WHISPER_TOKEN` on the backend previously had no env-level
  counterpart on the app, so a compose deployment following the security advice
  got a 401 on every transcription request until someone typed the secret into
  the UI.

### Changed

- `translateFile` split into `connection-health.ts` (availability probing, the
  per-job timeout breaker, the acquire/release wrapper) and `fallback-policy.ts`
  (per-line budgets and the fallback loop). None of that logic had been reachable
  from a test before.
- Client helpers consolidated: `str()` had four identical copies, `DashboardTab`
  two, and two form-control class strings were byte-identical.

### Fixed

- The connection breaker tested for `"timeout"` only, but the transcription
  client raises `"… timed out after 300s"` — so on the most common phrasing it
  never tripped and a dead connection was retried for the whole job.

## [0.5.2] — 2026-08-03

### Added

- **Errors explain themselves.** Raw failure strings (`fetch failed`,
  `terminated`, `[WinError 2] …`) are mapped to a cause and a next step in the
  Whisper history and the job details drawer. The raw text stays visible and
  selectable underneath. Hints are context-aware — the same `fetch failed` from a
  queue translation points at the LLM connection settings, not the Whisper
  service. Hand-translated for en/es/fr/de/ja/zh-CN/zh-TW; the other 25 locales
  carry the English sentence for now.

## [0.5.1] — 2026-08-01

### Added

- **Time remaining.** Active jobs show `~12m left · 42 cues/min`, plus a
  queue-wide estimate from the median of recent job durations. Jobs gained a
  `started_at` column (migrated automatically) — `updated_at` moves on every
  progress write and could not serve as a start time.
- **Grouped transcription failures.** A file that failed repeatedly is one row
  with an expandable attempt count instead of N identical rows, with
  **Retry all failed**.
- **Whisper library filter.** Search box and a "hide files with subtitles"
  toggle. Selections survive filtering, but Select all and Transcribe act only on
  what is visible.
- Windows installer now creates Start-menu and desktop shortcuts for the control
  window and tray, which shipped inside 0.5.0 with nothing pointing at them.

### Fixed

- **Translation could hang for hours instead of failing.** When a chunk failed on
  every connection, the per-line fallback retranslated it one line at a time,
  each call inheriting the full job timeout *and* its own retry budget — with a
  300s timeout and two connections a single 20-line chunk could occupy ~10 hours.
  Per-line work now uses a 60s cap, one retry, and aborts after 3 consecutive
  failures.
- A connection that keeps timing out is dropped for the rest of the job.
- **Interrupted jobs no longer leave a truncated subtitle that looks finished.**
  Incremental saves went straight to the output path, and the queue skips any job
  whose output exists — so a crashed job came back as "output already exists" and
  was marked done. Partial writes go to `<output>.part` and are renamed only on
  completion.
- **Deadlock in parallel mode**: a worker held its primary connection's lock for
  a whole job while a cascading chunk needed another connection's lock. Lock
  waits are now bounded.
- **Symlinks could escape the media directory** — the path guard compared
  lexically resolved paths. Both sides now resolve through `realpath`.
- **Every SSE progress event threw**: the optimistic `["jobs"]` cache update used
  a type that no longer existed and called `.map` on an object, so progress only
  moved on the 30s refetch.
- Saving settings wrote and logged ~60 keys every time; only genuine changes are
  written and logged now.

## [0.5.0] — 2026-07-31

### Added

- **Convert page translation** — uploaded subtitle files can be translated
  through the configured LLM connection pool, not just format-converted.
- **Transcription history management** — Clear button and per-row Remove on the
  Whisper page. Clearing drops finished entries only; running transcriptions are
  kept and subtitle files on disk are never touched.
- Dashboard date sorting with stable row identity across sort changes.

### Fixed

- Windows tray and GUI could not find `run_server.exe` unless launched from the
  bundle directory, failing with a bare `[WinError 2]`.
- The Whisper backend never read `config.json` and never wrote logs, because
  nothing set `SUBSMELT_WHISPER_CONFIG` / `SUBSMELT_WHISPER_LOG_FILE`. Both now
  default from `SUBSMELT_DATA_DIR` (`C:\ProgramData\SubSmelt`) on Windows.
- Transcription preflight returned an opaque 500 when the media root did not
  exist (offline mount, unconfigured path).
- Redacted settings keys stay out of the UI and are preserved when a client
  echoes the redaction marker back.

### Changed

- **Breaking:** the Whisper backend binds `0.0.0.0` by default instead of
  `127.0.0.1`, because SubSmelt usually runs in a container or on another machine
  and could not reach a loopback-only backend. **Without
  `SUBSMELT_WHISPER_TOKEN` set it accepts requests from any host on the network**
  — it warns loudly at startup. Set a token, or
  `SUBSMELT_WHISPER_HOST=127.0.0.1`.

### Engineering

- CI now gates releases: the TypeScript suite, typecheck, production build,
  pytest, and a Docker image build run on every PR, and both release workflows
  depend on them. Previously nothing ran tests anywhere.
- Client TypeScript is typechecked — `tsc -p tsconfig.json` had never run
  successfully because the client project referenced a non-composite server
  project.
- The Windows installer ships `whisper-gui.exe` and `whisper-tray.exe`; CI had
  never built them, so no released installer contained them.
