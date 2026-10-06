# TODO — Open Items

Known gaps with no work in progress. Context and rationale live in
[HANDOFF.md](HANDOFF.md) §5; shipped work is in [../CHANGELOG.md](../CHANGELOG.md).

## Security

- [ ] **SubSmelt has no authentication and binds `0.0.0.0`.** The README now says
      so plainly, but there is no optional token or auth mode.
- [ ] **Sign the Windows installer** — unsigned means a SmartScreen warning on
      every download. Needs a code-signing certificate.
- [ ] No rate limiting on either service.

## Refactoring

Sizes re-measured on 2026-09-30 on `release/0.6.0`; the guideline is 200–400
lines typical, 800 max. These two are the only source files over 800.

- [ ] `backend-whisper/app/main.py` — **883 lines**, up from 816 at 0.5.6.
- [ ] `backend-whisper/packaging/windows/tray/whisper_gui.py` — 858 lines.

## Whisper control app (Windows)

- [ ] No model manager or diagnostics (the tray app has both)

## Product / UX

- [ ] Per-job token cost is tracked but shown only as a total against the
      monthly budget on the dashboard, not per job
- [ ] **First-run flow is signposting, not a guided path.** Settings now shows
      which steps are outstanding and the Dashboard has a checklist, but there
      is still no wizard walking a new operator through the ~65 settings.
- [ ] `MediaSourcesPanel` is 349 lines but its main component is still the
      largest single thing in Settings → Sources

## YouTube

- [ ] **A cancelled premiere is retried about every hour forever.** Give `waiting` a limit.
- [ ] **A hard kill (SIGKILL) of the server outside Docker leaves yt-dlp running.**
      Normal stops and timeouts kill the whole process group.
- [ ] **A task deleted from the config drops its section from the note**, because the
      export needs the task's output pattern. Store the output path in `subtitle_plan`.
- [ ] Not yet tried live: "Added since" against the real YouTube Data API, a real
      cookies.txt for a Private playlist, and opening a note in Obsidian.
- [ ] The rate-limit check exists twice (`sync.ts` and `isCooldownCause` in `worker.ts`).

## Open questions

- [ ] **Resuming stopped jobs from `.part` files** — treat "translation equals source"
      as untranslated, or keep a sidecar list of translated cue indices (HANDOFF §5).
- [ ] **Installs that stored the redaction marker as their API key** re-enter it once;
      write a migration or leave it.

## Testing / infrastructure

- [ ] **Lock the Linux backend Docker image** like the Windows installer
      (`packaging/windows/constraints.txt`).
- [ ] The app has no favicon, so every page load logs a `/favicon.ico` 404.

- [ ] The CI runner has no `ffmpeg`, so the backend's ffmpeg paths are only
      exercised against mocks
- [ ] **Render tests cover four screens, first frame only.** `DashboardPage`,
      `SettingsPage`, `WhisperPage` and `ConvertPage` have `*.test.tsx` files
      that server-render them with seeded query data (`src/client/test-render.tsx`).
      Server rendering runs no effects and no clicks, so anything that appears
      after an effect (Settings loads its form in one) or an interaction is
      untested. `shell`, `LogsPage`, `TasksPage` and `JobDetailPage` have no
      render test.
