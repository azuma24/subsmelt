# SubSmelt — Information Architecture Audit & Progressive-Disclosure Redesign

**Author:** Senior Staff UX Architect (audit)
**Date:** 2026-06-13
**Constraint:** Remove **zero** functionality. Every control and every piece of information remains reachable. We only change *default visibility* and *placement*.

---

## 0. Method

### Four-layer model (applied to every screen)

| Layer | Name | Definition | Default visibility |
|-------|------|------------|--------------------|
| **L1** | Executive Summary | What is the system doing right now, and what is my next action? | Always visible, top of screen |
| **L2** | Operational Details | The working surface — the list/table/cards you act on | Visible, but visually subordinate to L1 |
| **L3** | Advanced Controls | Power-user knobs, tuning, bulk operations, rarely-changed config | Collapsed (accordion / "More" / drawer) |
| **L4** | Diagnostics / Raw Data | Errors, stack traces, IDs, raw paths, timings, logs, JSON | Off-canvas (drawer / dedicated page / expand-on-demand) |

### Disposition vocabulary (per element)

`Keep visible` · `Collapse by default` · `Move to accordion` · `Move to tab` · `Move to drawer` · `Move to modal` · `Move to separate page`

### How "visible complexity" is estimated

Count of **discrete interactive controls + distinct info blocks competing for attention in the default viewport** (before any user expansion). Reduction % = `1 − (default-visible count after / before)`. Modals/drawers count as **0** until opened.

---

## 1. Global findings

1. **The Dashboard is overloaded.** It is simultaneously a status board, a scan launcher, a transcription console, a queue manager, and a bulk-ops toolbar. ~38 default-visible controls/blocks. This is the #1 IA problem.
2. **Diagnostics leak everywhere.** Raw file paths, error reasons, durations, cue counts, and job IDs sit inline in primary tables. These are L4 data shown at L2.
3. **Bulk actions are always-on.** Six-plus bulk buttons render even when nothing is selected and nothing matches. They belong behind selection state or an "Actions" menu.
4. **Settings already has good bones** (left-nav sectioning) but each section dumps L1–L4 into one flat scroll.
5. **The shell footer mixes status (L1) with config echo (model name).** Fine to keep, but it's the right home for *global* status so screens don't each re-render it.

Target: **≥50% reduction in default-visible complexity on every screen**, 100% of functionality preserved.

---

## 2. Screen-by-screen audit

> Element counts are "default-visible" (pre-expansion). Citations reference the inventoried source files.

---

### 2.1 Dashboard (`DashboardPage.tsx`)

**Today (default-visible ≈ 38):** topbar (4) + 4 quick-start cards + 4 stat cards + active-job card + auto-translate notice + transcription header/count + transcription rows + queue header + 5 status tabs + 3 filter selects + clear-filters + 6 bulk buttons + quick-count summary + jobs table (7 columns × N rows with inline errors/paths/timings) + scan-results panel.

#### Element classification

| Element | Layer | Disposition |
|---------|-------|-------------|
| Title "Dashboard" | L1 | Keep visible |
| Run All / Stop (queue control) | L1 | **Keep visible** (primary next-action) |
| Scan Folders | L1 | Keep visible |
| Preview Scan | L3 | Collapse → into a "Scan ▾" split-button with Scan Folders |
| 4 stat cards (Pending/Translating/Done/Errors) | L1 | Keep — but **condense to one inline summary strip** (see redesign) |
| Active Job card | L1 | Keep visible |
| Auto-translate notice | L2 | Collapse by default → move into Settings echo / show only when OFF |
| 4 Quick-start onboarding cards | L2 | Collapse by default → show **only until first successful job**, then auto-hide behind "Setup ✓" chip |
| Status filter tabs (All/Pending/…) | L2 | Keep visible (this is how you navigate the queue) |
| Folder + Target-lang filter selects | L3 | Move to accordion ("Filters ▾") |
| Clear Filters | L3 | Move to accordion (with the filters) |
| 6 bulk buttons | L3 | **Move to a selection-context action bar** — render only when ≥1 selected, or behind an "Actions ▾" menu |
| Quick-count summary (pending/errors/done) | L4 | Collapse — redundant with stat strip |
| Jobs table: File name | L2 | Keep visible |
| Jobs table: full path under name | L4 | **Collapse** → reveal on row-expand / details drawer |
| Jobs table: Target + code | L2 | Keep (merge code into a tooltip/subscript) |
| Jobs table: Status badge | L1/L2 | Keep visible |
| Jobs table: error reason badge | L2 | Keep (it's the "why") |
| Jobs table: expandable full error | L4 | Keep as expand-on-demand (already correct) → also linkable to Logs |
| Jobs table: Progress | L2 | Keep visible |
| Jobs table: Time/duration | L4 | **Collapse** → move to details drawer / show only on hover |
| Jobs table: 7 per-row actions | L3 | **Collapse to a "⋯" row menu**; keep only the single contextual primary action inline (Retry on error, Preview on done) |
| Transcription history section | L2 | **Move to a tab** ("Transcription") or a collapsed accordion — it is a parallel workflow, not queue status |
| Scan-results panel | L2 | Keep, but collapsed group-by-folder (already grouped) |
| Preview overlay | L4 | Keep as modal (correct) |
| Scan confirmation | — | Keep as modal (correct) |

#### Redesigned into 4 layers

- **L1 — Executive Summary (always visible, compact header band):**
  - Title + **one status strip**: `⏳3 · 🔄1 · ✅42 · ⚠2` (the 4 stats collapsed into a single inline row, each segment clickable = filter).
  - **Active Job card** (what's running + progress).
  - Primary action button: **Run All / Stop**. Secondary: **Scan ▾** (Scan / Preview Scan).
- **L2 — Operational Details:**
  - Status filter tabs → the **Queue table** (File, Target, Status, Progress + one contextual action).
  - "Transcription" and "Scan results" as **sibling tabs** next to "Queue".
- **L3 — Advanced Controls (accordion / contextual):**
  - "Filters ▾" (folder, target, clear).
  - Selection action bar (appears on select): Run/Retry/Retranslate/Delete/Clear.
  - "⋯" per-row menu (pin, logs, details, delete, retranslate).
- **L4 — Diagnostics (drawer / expand):**
  - Row → **Job Details drawer**: full path, duration, cue counts, job ID, analysis context, full error, "Open in Logs".
  - Onboarding quick-start cards (auto-hidden after setup).

**Estimated reduction:** 38 → ~16 default-visible. **≈58%.** ✅

---

### 2.2 Translation Languages (`TasksPage.tsx`)

**Today (default-visible ≈ 12+):** topbar (2) + "Presets" label + N preset pills + conditional bulk panel + task grid (each card: checkbox, source→target, output pattern, lang code, prompt indicator, enabled toggle, edit, delete).

#### Element classification

| Element | Layer | Disposition |
|---------|-------|-------------|
| Title + Add Language | L1 | Keep visible |
| Preset pills | L2 | **Collapse → behind Add Language** as a "Quick add ▾" list; or show max 3 + "More" |
| Bulk selection panel | L3 | Keep, but it's already conditional (good) — make it a sticky context bar |
| Task card: source→target + code | L1 | Keep visible |
| Task card: enabled/disabled toggle | L1 | Keep visible (primary state) |
| Task card: output pattern (monospace) | L3 | **Collapse** → move to card back / details row; show only filename example |
| Task card: lang code label | L4 | Collapse (it's encoded in the target already) |
| Task card: custom-prompt indicator | L2 | Keep as a small chip |
| Edit / Delete | L2 | Edit keep; **Delete → into edit modal or ⋯ menu** (prevent mis-click) |
| Edit modal internals (format buttons, pattern, preview, prompt override) | L3/L4 | Already a modal (correct). Inside it: keep target/code/format at L1; **collapse pattern + prompt-override** (prompt override already collapsed — good). |

#### Redesigned into 4 layers

- **L1:** Title, Add Language, grid of cards showing only **Source→Target + enabled toggle**.
- **L2:** Custom-prompt chip; Edit affordance; selection context bar.
- **L3:** Output pattern + format (inside Edit modal, already); preset quick-add list collapsed.
- **L4:** Lang-code internals, delete confirmation.

**Estimated reduction:** card surface from ~7 fields → ~3. Screen default ~12 → ~6. **≈50%.** ✅

---

### 2.3 Logs (`LogsPage.tsx`)

**Today (default-visible ≈ 9 + entries):** topbar (title, job-filter indicator, follow checkbox, clear) + filter bar (level, category, search, job-id, clear-job, count) + log rows (timestamp, level, category, message, job link).

This screen **is** the diagnostics surface (L4 by nature), so the goal is *focus*, not relocation.

| Element | Layer | Disposition |
|---------|-------|-------------|
| Title | L1 | Keep |
| Follow (tail) checkbox | L1 | Keep visible |
| Clear logs | L3 | **Move into a ⋯ menu** (destructive, rarely used) |
| Search input | L1 | Keep visible (primary triage tool) |
| Level + Category selects | L2 | Keep, but **collapse into "Filters ▾"** with job-id |
| Job-ID filter | L3 | Move to accordion (Filters) |
| Entry count | L2 | Keep (subordinate text) |
| Log rows: timestamp/level/category/message | L2 | Keep (this is the content) |
| Job link | L2 | Keep |

#### Redesigned into 4 layers
- **L1:** Title, Search, Follow, level quick-pills (Error/Warn/Info as one-tap toggles).
- **L2:** Log stream + count.
- **L3:** "Filters ▾" (category, job-id), Clear in ⋯ menu.
- **L4:** (the rows themselves are the raw data).

**Estimated reduction:** 9 → ~5 controls in the filter region. **≈45–55%.** ✅ (borderline — acceptable since this screen is intentionally diagnostic.)

---

### 2.4 Settings (`SettingsPage.tsx`) — 5 sections behind left-nav

The left-nav already does first-level disclosure (one section visible at a time). Audit is **within** each section.

#### 2.4.1 LLM Connections (new `ConnectionsPanel`)
| Element | Layer | Disposition |
|---------|-------|-------------|
| Mode selector (single/fallback/parallel) | L1 | Keep visible |
| Connection cards: label, provider, active radio | L1 | Keep visible |
| API key, model | L2 | Keep visible |
| Endpoint (local) | L2 | Keep visible |
| Fetch-models, Test, per-card result | L3 | Keep (contextual) |
| Enabled / order ↑↓ | L3 | Keep in fallback/parallel only (already conditional) |
| Temperature slider | L3 | **Move to accordion** "Advanced ▾" (it's tuning, not connection) — or relocate to Translation Engine |

**Disposition note:** when **single** mode, collapse non-active cards to a one-line summary (label + provider + model) with an "edit" expander. Reduction within section ≈ 40%.

#### 2.4.2 Translation Engine
| Element | Layer | Disposition |
|---------|-------|-------------|
| System prompt textarea | L2 | **Collapse to accordion** ("Prompt ▾") — long, rarely edited |
| Additional context | L3 | Move to accordion (with prompt) |
| Chunk size, context window, parallel chunks, request timeout | L3 | **Move to "Advanced ▾" accordion** |
| Disable tool calls toggle | L4 | Move to "Advanced ▾" |

L1 here is essentially "it works out of the box" → show a one-line "Using defaults · Customize ▾". Reduction ≈ 70%.

#### 2.4.3 Sources & Monitoring
| Element | Layer | Disposition |
|---------|-------|-------------|
| Media sources panel | L1 | Keep |
| Auto-translate toggle | L1 | Keep |
| File-watcher toggle | L1 | Keep |
| Video/subtitle extensions | L3 | Move to "Advanced ▾" |
| Auto-scan interval | L3 | Move to "Advanced ▾" |

#### 2.4.4 Speech-to-Text (the densest section)
| Element | Layer | Disposition |
|---------|-------|-------------|
| Enable toggle | L1 | Keep |
| Backend URL | L1 | Keep |
| Test button + result | L2 | Keep |
| Model / Language / Output | L2 | Keep |
| Path map from/to + example | L3 | **Move to accordion** "Path mapping ▾" |
| Device / compute type / max-concurrent | L3 | Move to "Advanced ▾" |
| Line length / subtitle duration / merge-short | L3 | Move to "Advanced ▾" |
| VAD toggle | L3 | Move to "Advanced ▾" |
| Missing-subtitle / low-RAM behavior | L3 | Move to "Advanced ▾" |
| Folder defaults (JSON) | L4 | **Move to drawer / raw-config editor** |
| Advanced STT (JSON) | L4 | **Move to drawer / raw-config editor** |

STT default-visible ≈ 20 → ~6. **≈70%.** ✅

#### 2.4.5 Interface
Single select — already minimal. Keep.

**Settings overall estimated reduction: ≈55–60%.** ✅

---

### 2.5 Shell / Navigation (`shell.tsx`)
| Element | Layer | Disposition |
|---------|-------|-------------|
| Logo + title + version | L1 | Keep (version → tooltip on logo to de-clutter) |
| Nav links + error badge | L1 | Keep |
| Queue status dot | L1 | Keep — promote to **global** status (so Dashboard needn't duplicate) |
| Watcher status | L2 | Keep (subordinate) |
| Model-name badge | L3 | **Collapse → tooltip / Settings echo** (it's config, not status) |

Minor screen; ~20% reduction. Main win: it becomes the **single home for global status**.

---

## 3. Cross-cutting components to introduce

1. **`<JobDetailsDrawer>`** — right-side drawer holding all L4 job data (path, duration, cues, job ID, analysis context, full error, "Open in Logs"). Eliminates ~3 inline columns + inline error block from the table.
2. **`<RowActionsMenu>` ("⋯")** — collapses 7 per-row buttons to 1 contextual primary + overflow menu.
3. **`<StatusStrip>`** — the 4 stat cards condensed to one clickable inline segment row (doubles as filter).
4. **`<SelectionBar>`** — sticky context bar that renders bulk actions **only when items are selected**.
5. **`<Accordion>` / "Advanced ▾"** — reused across Settings sections and Dashboard filters.
6. **`<RawConfigEditor>` drawer** — houses the two STT JSON blobs and any future raw config.
7. **Tabs on Dashboard** — `Queue · Transcription · Scan results`.

All are *containers for existing controls* — no behavior is removed.

---

## 4. Screen-by-screen implementation plan (phased)

> Each phase is independently shippable and reversible. No functionality is deleted in any phase — controls are relocated/collapsed only.

### Phase 1 — Shared primitives (foundation)
- Build `<Accordion>`, `<Drawer>`, `<RowActionsMenu>`, `<SelectionBar>`, `<StatusStrip>`, `<Tabs>` in `src/client/ui/primitives.tsx` (or `ui/`).
- Add i18n keys for all new labels (mirror the existing `settings.connections` parity approach across all 17 locales + run the `node:test` parity check).
- **Acceptance:** primitives unit-rendered; locale parity test green.

### Phase 2 — Dashboard (highest impact)
1. Replace 4 stat cards with `<StatusStrip>` (segments filter the queue).
2. Wrap folder/target filters + clear in `<Accordion title="Filters">`.
3. Replace the 6 always-on bulk buttons with `<SelectionBar>` (renders on selection) + keep Run All/Stop in L1.
4. Collapse per-row actions into `<RowActionsMenu>`; keep one contextual primary inline.
5. Move path/duration/cues/job-id/full-error/analysis into `<JobDetailsDrawer>` opened from a row.
6. Move Transcription history + Scan results into `<Tabs>` beside Queue.
7. Auto-hide onboarding quick-start cards after first successful job (persist a `setup_dismissed` flag).
- **Acceptance:** default-visible count ↓ ≥55%; every former control reachable in ≤1 interaction; existing dashboard layout tests updated to assert the new structure (not deleted behavior).

### Phase 3 — Settings
1. Add an "Advanced ▾" accordion to each section; move tuning fields per §2.4.
2. Collapse Translation-Engine prompt + context behind "Prompt ▾".
3. Move the two STT JSON blobs into `<RawConfigEditor>` drawer.
4. Single-mode: collapse inactive connection cards to one-line summaries.
- **Acceptance:** STT section ↓ ≥65%; all fields still editable.

### Phase 4 — Tasks & Logs
- Tasks: card shows Source→Target + enabled toggle only; move pattern/format to the (existing) Edit modal; presets → "Quick add ▾"; delete → ⋯/modal.
- Logs: search + follow + error/warn/info quick-pills at L1; category/job-id into "Filters ▾"; Clear into ⋯ menu.
- **Acceptance:** Tasks card fields 7→3; Logs filter controls 9→~5.

### Phase 5 — Shell
- Promote queue status to global; demote model-name badge to tooltip; version → logo tooltip.

### Cross-phase guardrails
- **No deletions:** every PR diff must show controls *moved*, not removed. Add a checklist to each PR: "list every relocated control + its new home."
- **Reachability budget:** any previously-1-click action stays ≤2 clicks.
- Keep the `node:test` suites green (locale parity, layout assertions updated to new structure).

---

## 5. Summary — complexity reduction

| Screen | Default-visible before | after | Reduction |
|--------|------------------------|-------|-----------|
| Dashboard | ~38 | ~16 | **≈58%** |
| Settings · STT | ~20 | ~6 | **≈70%** |
| Settings · Translation Engine | ~8 | ~2 | **≈75%** |
| Settings · LLM Connections | per-card ~7 | ~4 | **≈40%** |
| Tasks | ~12 | ~6 | **≈50%** |
| Logs | ~9 (controls) | ~5 | **≈45–55%** |
| Shell | ~7 | ~5 | **≈25%** |

**Weighted outcome: ≥50% reduction in visible complexity across the app, with 100% of functionality and information preserved** (relocated to accordions, drawers, tabs, menus, and details panels).
