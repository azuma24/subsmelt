# TODO — Documented, Not Yet Implemented

Features described in the docs but with no implementing code (surfaced by the graphify
knowledge-graph audit: each was a degree-1 concept node with no edge into source).
Source-of-truth specs live in the linked docs; this file just tracks build status.

## Performance & architecture

- [x] **Split route bundles with `React.lazy`** — Settings/Logs/Tasks/Job detail lazy-loaded
  via `React.lazy` + `Suspense` in `App.tsx`; Dashboard stays eager. 4 separate chunks emitted.
  Spec: [2026-05-02-frontend-audit.md](2026-05-02-frontend-audit.md) §4 (P1).

- [x] **Virtualize large lists/tables** — `@tanstack/react-virtual` windowing (threshold 200,
  `scrollbarGutter: stable`, dynamic `measureElement`) applied to:
  `JobsTableDesktop.tsx` (queue), `PreviewOverlay.tsx` (cue table, 700+ rows — header/filters/TSV
  preserved, `scrollToIndex` for Jump-to-issue), `LogsPage.tsx` (variable-height rows + auto-scroll).
  `ScanResultsPanel.tsx` intentionally NOT virtualized — it's a two-level collapsible group tree
  with variable-height rows and small effective counts, not a flat list (wrong shape for windowing).
  Spec: [2026-05-02-frontend-audit.md](2026-05-02-frontend-audit.md) §6 (P1).

## Translation quality

- [x] **Refinement Pass (Pass 2)** — optional second LLM call per chunk for natural flow/tone,
  toggleable in Settings → Translation Engine. Implemented in `translator.ts` (`refineChunk`),
  default off (`refine_pass`), accepts refined output only on exact line-count match.
  Spec: [../SUB_SMELT_IMPROVEMENT_PLAN.md](../SUB_SMELT_IMPROVEMENT_PLAN.md) §3.

---

_Audit method: `/graphify` → `graphify-out/apply_bridges.py`. Re-run the graph audit after
building any of these to confirm the concept node now links to its implementing code._
