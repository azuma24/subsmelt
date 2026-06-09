# SubSmelt Frontend Audit

Date: 2026-05-02 07:30:32 CST

## Scope

Audit of the SubSmelt React/Vite frontend for optimizations and best practices. Focus areas:

- React architecture and component organization
- Performance and bundle size
- Accessibility
- Mobile/responsive UX
- Data fetching, state, SSE, and error/loading states
- i18n completeness
- UI polish and maintainability

No source files were modified by the audit agent.

## Executive summary

SubSmelt's frontend is functional and feature-organized, but the next high-leverage work is hardening the UI foundation after the recent STT feature expansion. The most valuable near-term improvements are:

1. Add a shared accessible modal/dialog shell.
2. Complete i18n for the new STT surfaces.
3. Add consistent query loading/error states and an app-level error boundary.
4. Split route bundles and reduce eager imports.
5. Refactor the large dashboard/settings surfaces into smaller focused components.
6. Improve SSE invalidation and large-list rendering for bigger media libraries.

## P0: high-impact quick wins

### 1. Add accessible modal/dialog behavior

Files:

- `src/client/components/ConfirmModal.tsx`
- `src/client/features/dashboard/PreviewOverlay.tsx`
- `src/client/features/dashboard/DashboardPage.tsx`
- `src/client/features/tasks/TasksPage.tsx`

Findings:

- Modal overlays are plain `div`s without `role="dialog"`, `aria-modal`, focus trap, initial focus, Escape handling, or focus restoration.
- Background content remains keyboard-reachable while modals are open.
- Icon-only close buttons need accessible labels.

Recommended slice:

- Create `src/client/components/ModalShell.tsx` with:
  - `role="dialog"`
  - `aria-modal="true"`
  - `aria-labelledby`
  - Escape close
  - focus trap
  - focus restore
- Refactor Confirm, Preview, Scan confirmation, and Task edit dialogs onto the shared shell.

### 2. Finish i18n for STT surfaces

Files:

- `src/client/features/dashboard/DashboardPage.tsx`
- `src/client/features/dashboard/ScanResultsPanel.tsx`
- `src/client/features/settings/SettingsPage.tsx`
- `src/client/features/settings/TranscriptionReadinessPanel.tsx`
- `src/client/locales/*/translation.json`

Findings:

- Many STT strings are hard-coded English.
- This regresses the existing multi-language UI promise.

Recommended slice:

- Add locale namespaces such as:
  - `settings.transcription.*`
  - `dashboard.transcription.*`
  - `scan.transcription.*`
- Replace hard-coded strings with `t(...)`.
- Add interpolated values for backend URL, RAM, model, suggested model, and status messages.

### 3. Add consistent query loading/error states

Files:

- `src/client/main.tsx`
- `src/client/api.ts`
- `src/client/features/dashboard/DashboardPage.tsx`
- `src/client/features/settings/SettingsPage.tsx`
- `src/client/features/dashboard/PreviewOverlay.tsx`
- `src/client/features/logs/LogsPage.tsx`

Findings:

- Several pages silently render empty data if queries fail.
- `fetchJSON` loses HTTP status/context.
- There is no route-level React error boundary.

Recommended slice:

- Add `src/client/ui/QueryState.tsx` with `PageLoading`, `PageError`, and `InlineError`.
- Add `src/client/components/AppErrorBoundary.tsx` around the app.
- Return richer `ApiError` from `fetchJSON` with HTTP status and safe message.
- Update Dashboard, Settings, Preview, and Logs to show retryable errors.

## P1: performance and architecture

### 4. Split route bundles with `React.lazy`

Files:

- `src/client/App.tsx`
- `src/client/i18n.ts`
- `vite.config.ts`

Findings:

- `App.tsx` eagerly imports every page.
- Settings pulls large STT/media/form code into the initial bundle.
- `i18n.ts` eagerly imports all locale JSON files.

Recommended slice:

- Lazy-load routes with `React.lazy` and `Suspense`.
- Keep Dashboard eager if desired, lazy-load Settings/Logs/Tasks/Job detail.
- Consider dynamic locale resource loading later.

### 5. Reduce dashboard recomputation and split the page

File:

- `src/client/features/dashboard/DashboardPage.tsx`

Findings:

- `DashboardPage.tsx` is large and owns many unrelated concerns.
- Derived job arrays, visible IDs, filters, counts, and scan stats are recomputed frequently.

Recommended slice:

- Extract `useDashboardDerivedState.ts`.
- Extract components:
  - `DashboardHero.tsx`
  - `QueueToolbar.tsx`
  - `TranscriptionHistoryPanel.tsx`
  - `ScanConfirmModal.tsx`
  - `MobileQueueActions.tsx`

### 6. Virtualize large lists/tables

Files:

- `src/client/features/dashboard/PreviewOverlay.tsx`
- `src/client/features/dashboard/JobsTableDesktop.tsx`
- `src/client/features/dashboard/ScanResultsPanel.tsx`
- `src/client/features/logs/LogsPage.tsx`
- `src/client/features/settings/MediaSourcesPanel.tsx`

Findings:

- Large collections render in full.
- Risk grows with large libraries, large logs, and long subtitle previews.

Recommended slice:

- Add virtualization for:
  1. Preview cue lines
  2. Logs rows
  3. Jobs table when queue > 200 rows
- Use `@tanstack/react-virtual` or a small internal virtual list.

### 7. Make SSE invalidation targeted and resilient

File:

- `src/client/hooks.ts`

Findings:

- `useSSE` invalidates several broad query keys on every event.
- JSON parsing is unguarded.
- Polling continues even when SSE is connected.

Recommended slice:

- Map event types to affected query keys.
- Wrap SSE JSON parsing in `try/catch`.
- Debounce invalidations within 250–500ms.
- Lengthen or disable polling while SSE is healthy.

### 8. Add abort-signal support to API/query layer

Files:

- `src/client/api.ts`
- `src/client/hooks.ts`

Findings:

- Fetch calls do not accept React Query cancellation signals.
- GET requests always receive `Content-Type` headers.

Recommended slice:

- Let `fetchJSON` accept `signal?: AbortSignal`.
- Thread React Query `signal` into API calls.
- Only send `Content-Type` when a request body exists.

## P2: maintainability and UX polish

### 9. Consolidate duplicated job action logic

Files:

- `src/client/features/dashboard/JobsTableDesktop.tsx`
- `src/client/features/dashboard/JobCardMobile.tsx`

Findings:

- Error classification and retry/retranslate logic are duplicated.
- Mobile action parity is weaker than desktop.

Recommended slice:

- Create `job-actions.ts` and `useJobActions.ts`.
- Share classification, retry, retranslate, pin/unpin, delete, and toast handling.
- Add mobile action parity for pin/delete/logs.

### 10. Replace stringly typed settings with a client-side schema

Files:

- `src/client/features/settings/SettingsPage.tsx`
- `src/client/features/settings/TranscriptionReadinessPanel.tsx`
- `src/client/api.ts`
- `src/client/types.ts`

Findings:

- Settings are `Record<string, unknown>` and many values are stringified booleans/numbers.
- STT JSON textareas do not validate before save.

Recommended slice:

- Add `ClientSettings` type and `settings-model.ts` parser/normalizer.
- Use existing `zod` dependency if useful.
- Validate `transcription_folder_defaults` and `transcription_advanced_stt` inline before save.

### 11. Confirm destructive single-job actions

Files:

- `src/client/features/dashboard/JobsTableDesktop.tsx`
- `src/client/features/dashboard/JobCardMobile.tsx`

Findings:

- Single job delete is immediate on desktop.
- Mutations need local error toast and pending disabled states.

Recommended slice:

- Use the shared confirm modal for single delete.
- Use `mutateAsync` or `onError` to show failure toasts.
- Disable buttons while the specific mutation is pending.

### 12. Improve form labeling and control accessibility

Files:

- `src/client/app/shell.tsx`
- `src/client/ui/primitives.tsx`
- `src/client/features/logs/LogsPage.tsx`
- `src/client/features/settings/SettingsPage.tsx`
- `src/client/features/dashboard/PreviewOverlay.tsx`

Findings:

- Some icon-only buttons lack accessible labels.
- `Field` labels do not attach via `htmlFor`/`id`.
- Progress bars lack progressbar ARIA.

Recommended slice:

- Update `Field` to generate/use IDs and connect labels.
- Add `aria-label` to icon-only buttons.
- Update `ProgressSmall` with `role="progressbar"` and `aria-valuenow`.

### 13. Fix mobile viewport and fixed-bottom overlap risk

Files:

- `src/client/App.tsx`
- `src/client/features/dashboard/DashboardPage.tsx`
- `src/client/app/shell.tsx`
- `src/client/index.css`

Findings:

- `h-screen` is risky on mobile dynamic viewport.
- Mobile bottom nav and dashboard action bar are both fixed.

Recommended slice:

- Use `h-dvh` / `min-h-dvh`.
- Add safe-area padding with `env(safe-area-inset-bottom)`.
- Increase bottom content padding when contextual mobile action bar is visible.

### 14. Add clipboard failure handling

File:

- `src/client/features/dashboard/PreviewOverlay.tsx`

Findings:

- Clipboard writes assume success.

Recommended slice:

- Add `copyText(text)` helper with fallback and error handling.
- Show success/failure toasts with i18n keys.

### 15. Remove dead dashboard code

File:

- `src/client/features/dashboard/DashboardPage.tsx`

Findings:

- `StepRow` appears unused.
- `NavLink` import exists only for that unused component.

Recommended slice:

- Delete unused `StepRow` and related import.

## Suggested implementation order

1. Accessibility modal shell + icon labels/progressbar attributes.
2. STT i18n completion.
3. Query error/loading states + app error boundary.
4. SSE invalidation tightening.
5. Dashboard derived-state hook and small component split.
6. Settings schema/JSON validation.
7. Route lazy loading and list virtualization.
8. Mobile safe-area polish.

## Notes

- Keep changes in small verified slices.
- Prefer one focused PR/commit per area.
- Start with accessibility and i18n because they are high-confidence and low-risk.
