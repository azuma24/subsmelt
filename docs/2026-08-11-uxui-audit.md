# SubSmelt — UX/UI Design Audit & Reorganization

**Date:** 2026-08-11 · **Scope:** every client screen
(Dashboard, Whisper, Convert, Translation Languages, Settings, Logs) + the shell.

This audit is grounded in the *current* code (line references are live as of the
date above), not the historical [UX-IA-Audit.md](UX-IA-Audit.md) (2026-06-13),
whose recommendations were **partly** implemented and which never covered the
Whisper and Convert screens. Read that document for the layering philosophy (the
four-layer L1–L4 model); this one for what is actually on screen now and what to
do next.

**Constraint carried over:** remove zero functionality. Every finding relocates,
groups, or re-styles — nothing is deleted from the product surface.

---

## 0. Headline

The app has a **mature design-system foundation** — a shared primitives library
(`src/client/ui/primitives.tsx`: `Accordion`, `Drawer`, `RowActionsMenu`,
`SelectionBar`, `Tabs`, `ActionButton`, `Field`, `StatusPill`, `EmptyHint`,
`SettingsSection`, `ProgressSmall`) with correct ARIA, 44px touch targets, and
theme tokens. The Dashboard/Settings/Tasks/Logs screens largely adopt it.

The problem is **inconsistent adoption**. Two screens (Whisper, Convert) were
built after the primitives landed and barely use them; the Dashboard re-rolls
tabs/buttons it already has primitives for; and a set of cross-cutting debts
(color-only status, sub-44px touch targets, hard-coded palette colors,
hard-coded English) recur on every screen. The single highest-leverage theme is
**"use what already exists, consistently."**

The five cross-cutting themes below account for ~70% of the findings. Fixing them
is more valuable than any single-screen redesign.

---

## 1. Cross-cutting themes (fix these first — they repeat everywhere)

### T1 — Under-used primitives / reinvented components  (High)
Same components, rebuilt inline with divergent styling, weaker a11y, and smaller
touch targets than the shared version.

| Where | Reinvents | Should use |
|---|---|---|
| `WhisperPage.tsx` (entire page) | buttons, cards, empty states, selects | `ActionButton`, `SettingsSection`, `EmptyHint`, `Field` — **uses zero primitives** |
| `WhisperPage.tsx:600-622` | bulk select/run row | `SelectionBar` |
| `QueueToolbar.tsx:50-61, 101-112` | tab pills (no ARIA, `py-[3px]` targets) | `Tabs` |
| `DashboardPage.tsx:638-655`, `QueueToolbar.tsx:164-195` | run/bulk buttons (`py-2` ≈ 32px) | `ActionButton` |
| `ConnectionsPanel.tsx:193-302` | label/endpoint/key/model inputs | `Field` (loses `useId` label link, `aria-invalid`) |
| `ConvertPage.tsx:303-347` | 3× `<label>+<select>` blocks | a shared `Select`/`SelectField` primitive (does not exist yet — **add one**) |

Dead/unadopted primitives to resolve: `StatusPill` (`primitives.tsx:6`) and
`Tabs` (`primitives.tsx:358`) are defined but unused — adopt (preferred) or drop.
`emerald` and `green` tones in `StatusPill` are identical (`primitives.tsx:8-9`).

### T2 — Status conveyed by color alone  (High — WCAG 1.4.1)
No secondary (icon/shape/text) cue in these spots:

- `shell.tsx:96-103` — queue + watcher dots; their text labels are `hidden lg:inline`, so at the **compact sidebar width the status is a bare colored dot**.
- `shell.tsx:137` — mobile active nav tab is accent-color text only (no underline/indicator, no `aria-current`).
- `DashboardHero.tsx:81` — over-budget spend signalled only by red text.
- `DashboardHero.tsx:67-76` — status filter cells: no `aria-pressed`.
- `WhisperPage.tsx:755` — the *active/transcribing* file is `--accent` vs `--text-3` text only.
- `SettingsPage.tsx:446, 384`, `ConnectionsPanel.tsx:298` — test-result rows are green/red text only.

Fix: pair every color signal with the existing ✓/✗/⚠ glyph set (see `HealthChips`, `primitives.tsx:122`) or a persistent text label, and add `aria-current` / `aria-pressed`.

### T3 — Touch targets below 44px  (Med — mobile)
Every hand-rolled button that skips `ActionButton` lands at ~28–34px: Whisper
(`:601, 611, 652, 660`), Dashboard bulk/run (`QueueToolbar.tsx:164-195`,
`DashboardPage.tsx:638-655`), Tasks bulk (`TasksPage.tsx:193-197`), Convert clear
(`ConvertPage.tsx:243`). Adopting `ActionButton`/`MiniBtn` fixes this for free.

### T4 — Off-theme hard-coded palette colors  (High — breaks light mode)
Raw Tailwind palette classes (`bg-blue-600`, `accent-blue-500`, `bg-gray-800`,
`border-red-700/60 bg-red-950/30 text-red-300`) instead of the CSS-var tokens
(`--accent`, `--on-accent`, `--red`, `--red-border`, `--red-dim`, `--surface*`)
used app-wide.

> **Scope correction (2026-08-11).** The first pass of this audit reported
> Whisper as "one of only two files" touching raw palette colors. That was
> wrong. A full sweep found **121 occurrences across 6 files**, and many are
> hard-coded *dark* values (`bg-gray-800`, `bg-red-950/30`, `text-gray-200`)
> that cannot adapt to the light theme the app ships a toggle for:
>
> | File | Occurrences |
> |---|---|
> | `features/dashboard/ScanResultsPanel.tsx` | 52 |
> | `features/dashboard/PreviewOverlay.tsx` | 40 |
> | `features/jobs/JobDetailPage.tsx` | 18 |
> | `components/ConfirmModal.tsx` | 6 |
> | `components/Toast.tsx` | 3 |
> | `components/ModalShell.tsx` | 2 |
> | ~~`features/whisper/WhisperPage.tsx`~~ | 0 — fixed in Phase B |
>
> This makes T4 a **larger and higher-priority** theme than first assessed:
> light mode is visibly broken on the scan panel, the subtitle preview and the
> job-detail page, not just on one button. It needs its own phase (see §4).

### T5 — Hard-coded English (i18n regression)  (Med)
The app promises 32 locales, but these bypass `t()`:
`DashboardPage.tsx:367, 409-413, 420, 457, 459` (transcription toasts);
`TasksPage.tsx:111, 122` (`"Bulk update failed"`);
`primitives.tsx:242, 283` (`aria-label="Close"`, `"Row actions"`);
several `t(key, "English default")` fallbacks in Settings that mask missing keys.

---

## 2. Screen-by-screen findings

### 2.1 Whisper  (`features/whisper/`) — worst offender, never audited
One ~200-line JSX blob (`WhisperPage.tsx:491-729`) rendering every control at the
same altitude in a single card, using **no** shared primitives.

- **[High] Flat, no layering (`:504-708`).** Title → 6 run options → download progress → URL input → 4 action buttons → filter/sort → refresh → count → file tree, all stacked. The file browser (the primary task) is buried below configuration. Fix: split into **Options / Source / Library** groups (`SettingsSection`), and collapse expert knobs (Device, Compute, Diarize — `:511-571`) into an `Accordion`.
- **[High] Two input modes compete in one column (`:582-597`).** Local-library picker vs URL/YouTube belong in a `Tabs` switch ("Library" / "URL"), not stacked inline.
- **[High] Undifferentiated action row (`:600-622`).** Transcribe (primary), Cancel (destructive), Select-all/Clear (selection mgmt) separated only by color. Use `SelectionBar` (which also gives the mobile stacked layout currently ignored).
- **[High] Folder tree a11y (`:783, 789`).** Disclosure button and checkbox share `aria-label={node.name}` → the folder name is announced 3×. Give the caret an action label and the checkbox a "select folder" label. `📁` at `:795` missing `aria-hidden`.
- **[Med] "Not downloaded" model marker (`:522`)** is a cryptic `▽` glyph + unreliable `<option>` color. Append explicit `" (not downloaded)"` text.
- **[Med] `enabled && !backendConfigured` shows nothing (`:504`).** No explanation when STT is on but the backend URL is blank. Add an `EmptyHint` branch.
- **[Med] Duplicated model-download logic (`:234-274` ≈ `:278-320`).** Extract one `confirmAndDownload(modelId)`.
- Plus T1 (zero primitives), T2 (`:755`), T3 (`:601+`), T4 (raw palette), and `isMobile` threaded but only tweaks padding (`:492`).

### 2.2 Convert  (`features/convert/ConvertPage.tsx`) — never audited
- **[High] Output settings fragmented (`:287-330` + `:333-357`).** "What language" is in one card; "what format" sits in a separate ungrouped row next to the CTA. They're one concern. Merge into a single **Output settings** group.
- **[High] Stale `fileErrors` bug (`:120-123, :90-109`).** `removeFile`/`addFiles` clear `lastOutputs` but not `fileErrors`, so per-file errors linger against files no longer staged. Clear both.
- **[High] Double empty state (`:235-236`).** An `EmptyHint` renders directly under the dropzone, which is *already* the empty state. Drop the redundant hint.
- **[Med] No progress + no `aria-live` (`:278-285, :359-385`).** Long translate runs show only a busy button; error/success regions aren't announced. Add `ProgressSmall` and `role="alert"`/`role="status"`.
- **[Med] Success card ignores `isMobile` (`:360-369`).** Header stays horizontal and cramps on phones — stack it.
- Plus T1 (3 reinvented selects), decorative-emoji iconography, dropzone `aria-label` ("Browse") mismatching visible text ("Drop files here").

### 2.3 Dashboard + shell  (`features/dashboard/`, `app/shell.tsx`)
- **[High] Hover-only desktop row actions (`JobsTableDesktop.tsx:123`).** `opacity-0 group-hover:opacity-100` hides Preview/Retry/Retranslate/Details/Delete until mouseover — invisible to touch users and keyboard focus lands on invisible controls. Keep visible, reveal on `focus-within`, or collapse into `RowActionsMenu`.
- **[High] "Skipped" job affordance hidden + mislabeled.** `StatusBadge` (`primitives.tsx:46`) styles `skipped` in the neutral gray branch (reads as inert). The "translate anyway" action exists only inside the hover-only cluster on desktop (`JobsTableDesktop.tsx:132`) and is labeled `retranslate` — wrong for a file never translated. Give `skipped` a distinct badge, an always-visible action, and a **"Translate anyway"** label.
- **[High] Duplicate status-filter controls.** `DashboardHero` status cells (`DashboardPage.tsx:546-556`) and `QueueToolbar` `FilterTabButtons` (`QueueToolbar.tsx:40-63, 115-123`) drive the *same* `statusFilter` with two different-looking widgets. Keep one.
- **[Med] Recovery actions buried (`QueueToolbar.tsx:126-197`).** "Retry visible errors" etc. live inside the collapsed "Filters" accordion. Hoist bulk actions to a visible row; keep only folder/target selects in the accordion.
- **[Med] 5+ chrome layers before the table (`DashboardPage.tsx:543-657`).** Metric band → quick-start → notice → title/subtitle → tab row → filter-tab row → filters accordion → selection bar → table. Merge the two tab rows; drop the redundant `QueueToolbar` title.
- **[Med] Table cell roles incomplete (`JobsTableDesktop.tsx:160-206`).** `role="table"/row/columnheader` set, but body cells lack `role="cell"`. Broken SR table.
- Plus T2 (shell dots, mobile tab), `aria-current` missing on nav (`shell.tsx:77-88, 124-142`), T1/T3 (tabs/buttons), T5 (toasts), dead `TopStatusBar` (`shell.tsx:120`).

### 2.4 Settings + Tasks + Logs  (largely audited already; residual items)
- **[High] STT section is a 186-line inline blob (`SettingsPage.tsx:416-602`).** None of the 5 section renderers were extracted into components. Ranked density: STT ~186 → Sources ~91 → Interface ~66 → Engine ~41 → LLM ~12. Extract `SttSection`, `SourcesSection`, `PathMappingFields`, `SttAdvancedFields`, `RawConfigDrawer`, `NotificationsFields`.
- **[High] No first-run / guided flow (`SettingsPage.tsx:673-737`).** ~60 settings, cold start on the LLM section, no gating, no progress. Add a first-run checklist (connection → source folder → target language → done).
- **[High] "Advanced" accordions open inconsistently.** Engine's `defaultOpen` (`:258, 274`) means its "Advanced" is expanded by default; STT (`:506`) and Sources (`:334`) are collapsed. Same label, opposite behavior. Make Advanced uniformly collapsed.
- **[Med] Single-mode connection cards not collapsed (`ConnectionsPanel.tsx:174-305`).** All cards render fully expanded regardless of mode/active — tall scroll. Collapse inactive cards to a one-line summary in `single` mode.
- **[Med] Mobile Settings uses raw `<details>` (`SettingsPage.tsx:697-710`)** for 4 sections but `SettingsSection` for LLM — two disclosure mechanisms, neither the shared `Accordion`; the `▸` never rotates. Use `Accordion` throughout.
- **[Med] `MediaSourcesPanel.tsx` — 941 lines**, 327-line main component, rendered fully inline under "Sources" with no disclosure of its own. Wrap the directory-rules/profiles editors behind an accordion; split the file.
- **[Med] Logs "Filters" accordion is styled borderless (`LogsPage.tsx:122`)** via an ad-hoc `border-none bg-transparent p-0` override — looks like a different component. Add a documented `variant="inline"` to `Accordion`.
- Plus T2 (test-result rows), T5 (Tasks bulk-error literals), two-save-mechanism model with no cue (`SettingsPage.tsx:96-122`), font-stepper `A−/A+` unlabeled (`:634, 642`).

---

## 3. Navigation / IA
Six flat `NAV_ITEMS` (`constants.ts:36-43`) with no grouping. The sidebar
(`shell.tsx:73-90`) and mobile bar (`shell.tsx:127-143`, all 6 forced into equal
`1fr` columns at `10.5px` — thumb-hostile) don't separate the **operate**
surface (Dashboard) from **create** (Translations / Whisper / Convert) from
**configure/diagnose** (Settings / Logs). Recommend: group with a divider/label
in the sidebar; on mobile show 4–5 primary items and move Logs (and possibly
Convert) into an overflow.

---

## 4. Prioritized roadmap

Each phase is independently shippable; none removes functionality.

**Phase A — Cross-cutting consistency (highest leverage).**
Adopt `ActionButton`/`Tabs`/`SelectionBar` where reinvented (T1, T3); pair every
color signal with icon/text + `aria-current`/`aria-pressed` (T2); swap Whisper's
raw palette for theme tokens (T4); i18n the hard-coded strings (T5); delete/adopt
dead primitives.

**Phase B — The two un-audited screens.**
Convert: merge output settings, fix the stale-errors bug, drop the double empty
state, add progress + `aria-live`. Whisper: split into Options/Source/Library,
collapse expert knobs into an `Accordion`, `Tabs` for Library-vs-URL, adopt
`SelectionBar`, fix folder-tree a11y, de-dupe download logic.

**Phase C — Dashboard focus.**
Un-hide row actions; give `skipped` a real "Translate anyway"; de-duplicate the
status-filter controls; hoist recovery actions out of the Filters accordion;
collapse the chrome stack; complete table cell roles.

**Phase D — Settings depth.**
Extract the 5 section renderers into components; uniform Advanced-collapsed
policy; collapse single-mode connection cards; `Accordion` on mobile; split
`MediaSourcesPanel`. Then the larger bet: a **first-run setup flow**.

**Phase E — Navigation grouping** (sidebar sections; trimmed mobile bar).

**Phase F — Light-theme repair (T4 sweep). — done.** Added after the scope
correction in §1; see §5.

---

## 4a. Theme-token rules (learned during Phase F)

Three rules for anyone touching colour in this codebase:

1. **Never use a raw Tailwind palette class.** `bg-gray-800`, `text-red-300`
   etc. are fixed values; they cannot follow the theme. Use the CSS-var tokens
   in `index.css` (`--surface*`, `--border*`, `--text*`, `--accent*`, `--green*`,
   `--yellow*`, `--red*`).
2. **Never pair a themed fill with an absolute foreground.**
   `bg-[var(--accent)] text-white` looks right in exactly one theme. Solid brand
   fills take **`text-[var(--on-accent)]`**, which is defined as the
   theme-inverse foreground (`#0b1020` dark / `#ffffff` light) and is correct on
   accent, green, yellow and red alike.
3. **Never put an opacity modifier on a `var()` colour.**
   `bg-[var(--surface)]/70` **emits no CSS at all** under Tailwind 3 — the class
   is silently dead and the element simply has no background. (Verified against
   the built stylesheet.) Use a dedicated tint token instead: `--accent-dim`,
   `--green-dim`, `--yellow-dim`, `--red-dim`, or `--border-sub`.

A grep that catches all three:

```
grep -rnE "\b(bg|text|border|accent|from|to|via|ring|fill|stroke|divide|outline|shadow|placeholder)-(blue|red|green|yellow|gray|emerald|slate|zinc|neutral|stone|orange|amber|indigo|purple|pink)-[0-9]" src/client --include=*.tsx
grep -rn "text-white\|text-black" src/client --include=*.tsx
grep -rnE "var\(--[a-z0-9-]+\)\]/[0-9]+" src/client --include=*.tsx
```

All three return nothing as of Phase F; keep it that way.

---

## 5. Implementation progress
Commit series on `claude/sampling-temperature-settings-19ilwb`.

**Convert (Phase B, first slice) — done.** Output settings unified into one group,
the stale-`fileErrors` bug fixed, the double empty state removed, result/error
regions given live-region semantics, success card made responsive.

**Phase A (cross-cutting) — T2 + T5 done.**
- *T2 (color-only status):* shell queue/watcher status is now sr-only-not-hidden
  below `lg` (never color alone for screen readers) with a hover `title`; mobile
  active nav tab gets an indicator bar + bolder weight; Dashboard hero filter
  cells expose `aria-pressed` and over-budget shows a ⚠ glyph; Settings /
  Connections test-result rows prefix ✓/✗. Dead `TopStatusBar` removed.
- *T5 (i18n):* Dashboard transcription toasts, the Tasks bulk-update error, and
  the `Drawer`/`RowActionsMenu` aria-labels now use `t()` keys, translated across
  all 32 locales.
- *T1/T3 (adopt `ActionButton`/`Tabs`, touch targets) — deferred into Phases B & C
  intentionally:* the reinvented buttons/tabs live inside the Whisper and
  Dashboard layouts that those phases restructure, so adopting the primitives
  there avoids doing the work twice.

**Phase B (Whisper) — done.** Split into Run options / URL / Library; expert
knobs (device, compute, diarize) collapsed behind an Advanced accordion; run
actions moved into `SelectionBar`; the missing "enabled but no backend URL"
notice added. Adopted `SettingsSection`, `Accordion`, `SelectionBar`,
`ActionButton`, `EmptyHint` (the page previously used none), which also resolved
its T1/T3 debt. All raw palette classes replaced with theme tokens (T4 for this
file). A11y: distinct accessible names for the folder caret/checkbox/name button,
non-colour cue for the transcribing file, "not downloaded" spelled out, row
checkboxes frozen mid-batch. The two confirm-then-download blocks were collapsed
into one helper.

*Deviation from the audit's own recommendation:* §2.1 proposed a `Tabs` switch
for Library-vs-URL. Rejected during implementation — the run options apply to
**both** modes, so a mode switch would leave shared settings floating outside the
tabs and imply they were mode-specific. Three labelled sections achieve the same
layering without that false implication.

**Phase F (light-theme repair) — done.** All 183 raw palette classes across
`ScanResultsPanel`, `PreviewOverlay`, `JobDetailPage` and `ModalShell` replaced
with theme tokens. `Toast` moved to an opaque surface fill with the semantic
colour on border/icon/text (the tint tokens are too sheer for a floating
element). `ConfirmModal`'s buttons now mirror `ActionButton`'s primary/danger
variants.

Verifying the sweep surfaced **two further defect classes not in the original
audit**, both fixed:

- **Absolute foregrounds on themed fills.** `bg-[var(--accent)] text-white`,
  `bg-[var(--green)] text-black` and friends invert contrast in one theme.
  This included `ActionButton`'s own `success` variant, so *every* success
  button in the app was affected — in dark mode for the green/yellow fills and
  in light mode for the accent fills. 19 occurrences across 9 files.
- **Dead opacity-on-var classes.** `bg-[var(--surface)]/70` and similar emit no
  CSS whatsoever under Tailwind 3. Three were introduced by this pass's
  mechanical substitution (a `/70` suffix left stranded when `bg-gray-900/70`
  became `bg-[var(--surface)]`); two were pre-existing, one of which left
  `ActiveJobCard`'s indeterminate progress shimmer with no background at all.

See §4a for the resulting rules and the greps that enforce them.

**Phases C, D and E — done.** Built in parallel by three agents in isolated
worktrees, then merged and re-verified together.

- *C (Dashboard):* row actions no longer hover-only; `skipped` gets a distinct
  `⊘` badge and an always-visible **"Translate anyway"** (desktop and mobile);
  the duplicate status-filter pill row deleted in favour of the hero cells;
  bulk recovery actions hoisted out of the collapsed Filters accordion;
  `role="cell"` completed; `Tabs`/`ActionButton` adopted.
- *D (Settings):* `SettingsPage` 755 → 386 via `sections/`; `MediaSourcesPanel`
  941 → 337 via `media-sources/`; `ConnectionCard` extracted onto `Field` and
  `RowActionsMenu`; single-mode cards collapse; mobile `<details>` → `Accordion`;
  `Accordion variant="inline"` for Logs.
- *E (Navigation):* sidebar grouped Operate / Create / System; mobile bar
  trimmed to four primary items plus a "More" drawer holding Convert and Logs,
  every destination still ≤2 taps.

**Merge caveat worth remembering.** The worktrees branched from the default
branch, not the feature branch, so they started without Phases A/B/F. C detected
this and rebased; D and E did not, and silently reverted work on merge — the
0.3 temperature default, the ✓/✗ test-result glyphs in three places, and the
deleted `TopStatusBar`. All were caught during merge and re-applied. If agents
are used this way again, pin their base.

**Verified in a browser, not just by build.** All six routes in light and dark,
plus mobile, with seeded fixtures (in-progress, pending, skipped, error and done
jobs; a scanned library; a completed translation). Zero page errors. This
covered the screens that a token mistake would show up on first —
`ScanResultsPanel`, `PreviewOverlay`, the `skipped` badge and the active-job
cards — none of which render on an empty install.

### Still open
- `WhisperPage.tsx` is 840 lines — it *grew* during Phase B (see TODO.md).
- No render tests for any screen; the whole UX pass is protected only by
  typecheck, build and locale parity.
- `errors.*` is English-verbatim in all 31 non-English locales.
- First-run is signposting, not a guided wizard.
