# PRD — Directory Rules (per-directory translation control)

Status: approved for build · Owner: azuma24 · Date: 2026-06-14
Branch: `feat/directory-rules`

## 1. Problem

Today every enabled translation task (= target language) fans out to **every** subtitle file in scope, and videoless ("orphan") subtitles already translate globally (`scanner.ts:343`, no video guard). Users have no way to:

1. Control, per directory, whether videoless subtitles get translated.
2. Map specific directories to specific target languages (e.g. `/Anime/JP-only → Japanese`, `/Dramas/TW → Traditional Chinese`).

## 2. Goals

- **G1 — Videoless opt-in per directory.** A directory (and its subfolders) can enable/disable translation of subtitles that have no companion video file. Global baseline is configurable; default **off** (opt-in).
- **G2 — Per-directory language mapping (additive).** A directory rule can attach extra target-language tasks to files in that subtree. Additive: effective languages = global enabled tasks **∪** the rule's task IDs.
- **G3 — Zero migration, backward compatible storage.** Reuse the existing JSON-in-settings pattern (`scan_profiles`, `llm_connections`). No new DB table.

## 3. Non-goals

- Replace-mode language mapping (chosen: additive). To get "Dir A → JP only", disable JP globally and add it via a rule.
- Per-file rules. Rules are path-prefix scoped to directories.
- Rewriting existing jobs already queued. Only new scans honor the gate.

## 4. Decisions (locked)

| # | Decision | Value |
|---|----------|-------|
| D1 | Default for videoless subs with no matching rule | **OFF** (opt-in). Global `translate_without_video = "off"`. |
| D2 | Rule language semantics | **Additive** — union with global enabled tasks. |
| D3 | Scope | Path-prefix; subfolders inherit the nearest ancestor rule. |
| D4 | Conflict resolution | Longest-prefix (most specific) wins for the videoless flag; tri-state `inherit` falls through to ancestor, then global default. Task IDs union across all matching rules. |

## 5. Data model

Stored as JSON string in settings key `directory_rules`. New global setting `translate_without_video` (`"on"` | `"off"`, default `"off"`).

```ts
interface DirectoryRule {
  id: string;                                   // uuid
  path: string;                                 // relative to MEDIA_DIR, posix, no leading/trailing slash; "" = root
  enabled: boolean;
  translateWithoutVideo: "inherit" | "on" | "off";
  taskIds: number[];                            // extra language-tasks to apply in this subtree
}
```

Resolution (`resolveDirectoryRule(relDir, rules, globalDefault)`):
- Match = enabled rules where `rule.path === ""` OR `relDir === rule.path` OR `relDir.startsWith(rule.path + "/")`.
- `translateWithoutVideo`: walk matches most-specific→least; first non-`inherit` wins; else `globalDefault`.
- `extraTaskIds`: union of `taskIds` across **all** matching rules.
- `matchedRuleId`: most-specific matched rule id (for UI display), else null.

## 6. Backend changes

- **`src/server/directory-rules.ts`** (new): types, `parseRules(raw)`, `resolveDirectoryRule(...)`, path normalization.
- **`src/server/config.ts`**: defaults `directory_rules: "[]"`, `translate_without_video: "off"`.
- **`src/server/scanner.ts`** (`scanFolder`, ~line 343): parse rules + global default once; per-subtitle compute `relDir`, resolve rule; (a) **orphan gate** — if `videoPath === null && !resolved.translateWithoutVideo` → skip (no jobs); (b) **effective task set** — iterate `enabledTasks ∪ tasks(extraTaskIds)` (extra tasks included even if globally disabled, so long as the task exists).
- No new API endpoint — rules persist through existing `POST /api/settings`.

## 7. Frontend changes

- **`MediaSourcesPanel.tsx`**: new **Directory Rules** section (cards). Each card: folder picker (from detected folders + root), tri-state "Translate subtitles without video" (inherit/on/off), language multiselect (checkboxes from Tasks), remove. `+ Add rule`. Fetches tasks via `api.getTasks()`.
- **`SettingsPage.tsx`** `sourcesContent`: global `translate_without_video` toggle + wire new props (`directoryRules`, `translateWithoutVideo`, change handlers).
- i18n: `settings.sources.dirRules.*` + global toggle keys across all locales (parity enforced by `locale-coverage.test.ts`).

## 8. Behavior change / release note

After upgrade, **new scans stop creating jobs for videoless subtitles** unless (a) a directory rule opts in, or (b) the global `translate_without_video` toggle is set to ON. Existing queued orphan jobs are untouched. Surface in CHANGELOG / release notes. Global toggle lets users restore prior behavior in one click.

## 9. Testing

- `src/server/directory-rules.test.ts` (node:test): parse validation, longest-prefix, inherit fall-through, union task IDs, disabled-rule skip, global default.
- Locale parity green (`locale-coverage.test.ts`).
- Build green (`npm run build`), full suite (`npx tsx --test`).

## 10. Rollout

Additive + default-off baseline preserves correctness; behavior change is gated and reversible via global toggle. Single PR on `feat/directory-rules`.
