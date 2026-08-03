# TODO — Open Items

Known gaps with no work in progress. Context and rationale live in
[HANDOFF.md](HANDOFF.md) §4; shipped work is in [../CHANGELOG.md](../CHANGELOG.md).

## Security

- [ ] **SubSmelt has no authentication and binds `0.0.0.0`.** The README now says
      so plainly, but there is no optional token or auth mode.
- [ ] **Sign the Windows installer** — unsigned means a SmartScreen warning on
      every download. Needs a code-signing certificate.
- [ ] No rate limiting on either service.

## Refactoring

Sizes as of 0.5.3; the guideline is 200–400 lines typical, 800 max.

- [ ] `src/client/features/settings/MediaSourcesPanel.tsx` — 941 lines
- [ ] `backend-whisper/app/main.py` — 816 lines
- [ ] `src/client/features/whisper/WhisperPage.tsx` — 808 lines
- [ ] `src/client/features/settings/SettingsPage.tsx` — section renderers of
      112–189 lines each, naturally separate components

## Whisper control app (Windows)

- [ ] Status is never polled — a crashed backend still shows "● Running"
- [ ] A failed start reports success: `Popen` returning is treated as "started",
      so a port conflict with the installed service goes unnoticed
- [ ] Host/port/token are session-only; the GUI never writes `config.json`, which
      `run_server` now reads by default
- [ ] No warning when binding `0.0.0.0` without a token
- [ ] No model manager or diagnostics (the tray app has both)

## Product / UX

- [ ] The [UX/IA audit](UX-IA-Audit.md) never covered the **Whisper and Convert
      pages** — the newest and most-used screens
- [ ] "Skipped" jobs look identical to "done"; no "translate anyway" affordance
- [ ] Status is conveyed by colour alone in several places
- [ ] No first-run setup flow (~60 settings, no guided path)
- [ ] Per-job token cost is tracked but never shown against the configured
      monthly budget

## Testing / infrastructure

- [ ] The CI runner has no `ffmpeg`, so the backend's ffmpeg paths are only
      exercised against mocks
- [ ] 25 of 32 locales carry English text for the 0.5.2 error explanations

---

## Done

- [x] **Split route bundles with `React.lazy`** — Settings/Logs/Tasks/Job detail
      lazy-loaded via `React.lazy` + `Suspense` in `App.tsx`; Dashboard stays
      eager. 4 separate chunks emitted.
      Spec: [2026-05-02-frontend-audit.md](2026-05-02-frontend-audit.md) §4 (P1).
- [x] **Virtualize large lists/tables** — `@tanstack/react-virtual` windowing
      (threshold 200, `scrollbarGutter: stable`, dynamic `measureElement`) in
      `JobsTableDesktop.tsx`, `PreviewOverlay.tsx` and `LogsPage.tsx`.
      `ScanResultsPanel.tsx` is deliberately excluded: a two-level collapsible
      tree with variable-height rows is the wrong shape for windowing.
      Spec: [2026-05-02-frontend-audit.md](2026-05-02-frontend-audit.md) §6 (P1).
- [x] **Refinement Pass (Pass 2)** — optional second LLM call per chunk for
      natural flow/tone, toggleable in Settings → Translation Engine, default
      off, accepted only on an exact line-count match.
      Spec: [../SUB_SMELT_IMPROVEMENT_PLAN.md](../SUB_SMELT_IMPROVEMENT_PLAN.md) §3.
