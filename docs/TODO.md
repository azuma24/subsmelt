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

- [ ] `backend-whisper/app/main.py` — **892 lines**, up from 816. The 0.6.0
      backend fixes added to it without extracting anything.
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

## Testing / infrastructure

- [ ] The CI runner has no `ffmpeg`, so the backend's ffmpeg paths are only
      exercised against mocks
- [ ] **Render tests cover four screens, first frame only.** `DashboardPage`,
      `SettingsPage`, `WhisperPage` and `ConvertPage` have `*.test.tsx` files
      that server-render them with seeded query data (`src/client/test-render.tsx`).
      Server rendering runs no effects and no clicks, so anything that appears
      after an effect (Settings loads its form in one) or an interaction is
      untested. `shell`, `LogsPage`, `TasksPage` and `JobDetailPage` have no
      render test.

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
      Implemented in `src/server/translator/prompt.ts` (`refineChunk`).

### 0.5.7 to 0.6.0

- [x] **`WhisperPage.tsx` split** — 840 → 496 lines. 0.5.7 extracted
      `LibraryPicker`, `RunOptionsSection`, `UrlTranscribeSection`,
      `useModelGate` and `whisper-shared`; 0.6.0 moved the batch runner into
      `batch-store`.
- [x] **`errors.*` translated in all 31 non-English locales** — 611 of 713
      values were still English. `locale-coverage.test.ts` now fails if any
      `errors.*` value matches English.
- [x] **First render tests** — see the open item under Testing for their limits.

### 2026-08 UX/UI pass
Spec and remaining roadmap: [2026-08-11-uxui-audit.md](2026-08-11-uxui-audit.md).

- [x] **Whisper and Convert audited** — the two screens the 2026-06 IA audit
      never reached. Both restructured (audit §2.1–2.2, Phase B).
- [x] **"Skipped" jobs** — own badge (`⊘`, amber, distinct from done/pending)
      plus an always-visible **"Translate anyway"** action on desktop and
      mobile, replacing the mislabelled hover-only "Re-translate".
- [x] **Status conveyed by colour alone** — sidebar queue/watcher labels are
      `sr-only` rather than hidden at compact width, the mobile active tab has
      an indicator bar, hero cells expose `aria-pressed`, over-budget gains a
      ⚠, and test-result rows prefix ✓/✗.
- [x] **`SettingsPage` section renderers extracted** — 755 → 386 lines, five
      sections plus four sub-groups under `features/settings/sections/`.
- [x] **`MediaSourcesPanel` split** — 941 → 337 lines, with `model.ts`,
      `FolderTree`, `DirectoryRulesSection` and `ScanProfilesSection` extracted.
- [x] **Light theme repaired** — 183 raw Tailwind palette classes replaced with
      theme tokens across `ScanResultsPanel`, `PreviewOverlay`, `JobDetailPage`
      and `ModalShell`; absolute `text-white`/`text-black` on themed fills fixed
      (including `ActionButton`'s success variant); dead opacity-on-var classes
      removed. Rules + enforcement greps in the audit §4a.
- [x] **Google Fonts request removed** — `index.html` no longer fetches
      JetBrains Mono from a third party, which the README's "no data leaving
      your network" promise did not permit. Falls back to the platform mono
      stack; verified zero off-origin requests.
- [x] **Quick-start "LLM connection" step was always ticked** — it read
      `llm_endpoint`/`model`, which ship with non-empty defaults. Now computed
      server-side from the raw stored settings (`_llm_configured`).
- [x] **The Whisper backend's log is reachable** — `GET /logs` on the backend
      (token or loopback), surfaced as a *Whisper backend* source on the app's
      Logs page, plus "View log" in the Windows control GUI. `/health` also
      reports whether file logging attached and why not, closing a silent
      failure where a bad log path produced no file and no warning (the warning
      went to a stderr that neither a service nor the GUI's child process has).
