# SubSmelt — Handoff

Orientation for someone picking this project up. Current as of **0.5.6**
(2026-08-04). For what changed when, see [../CHANGELOG.md](../CHANGELOG.md); for
how to run it, see [../README.md](../README.md).

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
src/server/          Express API, queue, scanner, watcher, SQLite
  translator/        LLM translation: engine, chunking, prompts, parsing
  transcription/     Whisper backend client (HTTP, request building)
  routes/            HTTP route registration
src/client/          React SPA (Vite, Tailwind, react-query)
  features/          One directory per screen
  lib/               Framework-free helpers (clipboard, error taxonomy, settings)
  locales/           32 translation bundles
backend-whisper/     FastAPI + faster-whisper sidecar
  app/               Endpoints, preflight, model management, GPU probing
  packaging/windows/ PyInstaller specs, Inno Setup installer, tray/GUI apps
```

### The parts worth understanding first

**`src/server/queue.ts`** — the job pump. Workers claim pending jobs from SQLite
(`claimPendingJob` is a single transaction, so concurrent workers cannot double
claim), resolve the LLM connection pool per job, and call `translateFile`. The
worker pool adapts to the configured LLM mode on every claim, so switching
single/fallback/parallel takes effect mid-run.

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
beginning; there is no mid-file resume.

---

## 3. Working on it

```bash
npm ci --legacy-peer-deps   # the flag is required; see below
npm run dev          # server (tsx watch) + vite, concurrently
npm test             # node:test over src/**/*.test.ts(x)
npm run typecheck    # client AND server projects
npm run build        # typecheck, then vite build, then tsc for the server

cd backend-whisper
pip install -r requirements.txt pytest
python -m pytest tests -q          # must be run from backend-whisper/
```

`--legacy-peer-deps` is not optional: `i18next@26` declares an optional
TypeScript peer of `^5 || ^6`, this repo is on TypeScript 7, and npm 10 (bundled
with Node 22) refuses the install. The Dockerfile and CI pass the same flag.

Client and server are separate TypeScript projects (`tsconfig.json` /
`tsconfig.server.json`) with no project reference between them — the client never
imports server code, and adding a reference forces `composite`, which the server
build cannot use. `npm run typecheck` checks both; **`vite build` does not
typecheck**, so do not treat a green build as a green typecheck.

### CI and releases

`.github/workflows/ci.yml` runs the TypeScript suite, both typechecks, the
production build, pytest, and a Docker image build (no push) on every PR and push
to `main`. Both release workflows declare `needs: test`, so nothing publishes
without it.

Releasing is two tags on the same commit — full procedure, constraints and the
current release status in **[RELEASING.md](RELEASING.md)**:

```bash
# bump package.json, backend-whisper/app/version.py and
# backend-whisper/packaging/windows/installer.iss together
git tag -a v0.5.6 -m "SubSmelt 0.5.6" && git tag -a whisper-v0.5.6 -m "..."
git push origin v0.5.6 whisper-v0.5.6
```


`v*` publishes the Docker image; `whisper-v*` builds the Windows installer and
creates its GitHub release with the installer attached. The app's release notes
are written by hand afterwards. The installer is ~1 GB because the cuDNN and
cuBLAS wheels are bundled (703 MB + 528 MB compressed) — **no model weights are
included**; the model manager downloads those on first use.

---

## 4. Known gaps

Nothing here is in progress. Ordered by what I would fix first.

### Security

- **SubSmelt has no authentication and binds `0.0.0.0`.** Anything on the LAN can
  drive the API, browse media paths, and change settings. Acceptable on a trusted
  network, but it is not documented as a deliberate choice anywhere except the
  Noted in the README.
- **The Whisper backend binds `0.0.0.0` by default** and only warns when no token
  is set (a loopback-only backend is unreachable from a
  container). The token has to be set on both sides: `SUBSMELT_WHISPER_TOKEN` on
  the backend and `WHISPER_BACKEND_TOKEN` (or the Settings field) on the app,
  otherwise every request 401s.
- **The Windows installer is unsigned**, so SmartScreen warns on every download.
  Needs a certificate.
- No rate limiting on either service.

### Correctness and coverage

- `WhisperPage.tsx` (840 lines) and `backend-whisper/app/main.py` (816) exceed
  the 800-line guideline. Whisper *grew* during the 2026-08 restructure —
  layering it added wrappers without extracting anything; `FileRow` and
  `FolderNodeView` are the obvious split. `MediaSourcesPanel.tsx` (941 → 337)
  and `SettingsPage.tsx` (755 → 386) were split in that same pass.
- The CI runner has no `ffmpeg`, so the backend's ffmpeg paths are only exercised
  by tests that mock it.
- **All 31 non-English locales** carry English text for the error explanations
  ~19 `errors.*` values each. (An earlier "25 of 32" figure
  here was wrong; re-measured 2026-08-12.)
- **No screen has a render test.** The suite is server logic, pure helpers and
  locale parity; nothing mounts the page components. The 2026-08 UX pass rewrote
  much of that JSX without adding coverage.

### Product

The [2026-08 UX/UI audit](2026-08-11-uxui-audit.md) supersedes the
[2026-06 IA audit](UX-IA-Audit.md) and now covers every screen, including the
Whisper and Convert pages the older one never reached. Phases A–F are
implemented (audit §5); Phase D's first-run item shipped as *signposting* —
Settings shows what is outstanding and the Dashboard has a checklist, but there
is still no guided wizard through the ~60 settings.

The Whisper control window still lacks the model manager and diagnostics the
tray app has. It can now tail the log in-window ("View log"), resolving
the path with `run_server`'s own precedence.

---

## 5. Document status

| Document | Status |
|---|---|
| [../README.md](../README.md), [../CHANGELOG.md](../CHANGELOG.md), this file | Current |
| [TODO.md](TODO.md) | Current — open items only |
| [RELEASING.md](RELEASING.md) | **Current** — release procedure and tag-push constraints |
| [2026-08-11-uxui-audit.md](2026-08-11-uxui-audit.md) | **Current** — covers every screen; Phases A–F implemented (§5), C/D/E roadmap items remain in §4. §4a holds the theme-token rules and their enforcement greps |
| [UX-IA-Audit.md](UX-IA-Audit.md) | Historical (2026-06-13); superseded by the 2026-08 audit, which re-verified what actually shipped |
| [2026-05-02-frontend-audit.md](2026-05-02-frontend-audit.md) | Historical; its P1 items are done (see TODO.md) |
| [windows-whisper-server-plan.md](windows-whisper-server-plan.md) | Historical build plan; the packaging it describes shipped in 0.5.x |
| [PRD-directory-rules.md](PRD-directory-rules.md), [PRD-multi-llm-connections.md](PRD-multi-llm-connections.md) | Historical PRDs for shipped features |
| `SubSmelt Redesign.html` | Design mock, unmaintained |

Historical documents are kept for the reasoning behind decisions. **Do not treat
them as descriptions of current behaviour** — several describe intentions that
shipped differently.
