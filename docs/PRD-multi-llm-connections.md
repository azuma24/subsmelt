# PRD: Multiple LLM Connections (Fallback & Parallel Translation)

**Status:** Draft
**Author:** azuma24
**Date:** 2026-06-13
**Related code:** `src/server/config.ts`, `src/server/queue.ts`, `src/server/translator.ts`, `src/client/features/settings/SettingsPage.tsx`

---

## 1. Summary

Today SubSmelt has **one** active LLM connection. The user picks a single provider (`local | openai | anthropic | gemini`) in Settings, and every translation job uses that one connection.

This feature lets the user configure **multiple LLM connections** (2nd, 3rd, …) in Settings via a `+` button, then use them for either:

- **Fallback mode** — if connection #1 fails (rate limit, timeout, error), automatically retry the batch on connection #2, then #3.
- **Parallel mode** — split a job's chunks across multiple connections to translate faster (throughput scaling).

---

## 2. Problem & Motivation

### Current state (single connection)

- `DEFAULT_SETTINGS` (`config.ts:32-89`) stores flat per-provider keys: `cloud_provider`, `cloud_api_key_openai`, `cloud_model_openai`, `cloud_api_key_anthropic`, etc. Only **one** `cloud_provider` is active at a time.
- The queue derives a single `apiKey` / `apiHost` / `model` per job from the active provider (`queue.ts:77-91`).
- `translateFile` → `translateChunk` → `getAi()` create **one** AI client; retries (`retryTranslate`, 5 attempts) hit the **same** provider. No cross-provider fallback (`translator.ts`).

### Pain points

1. **No resilience.** A rate limit or outage on the active provider fails the whole job. The user must manually switch providers and re-run.
2. **No throughput scaling.** `parallel_chunks` already exists, but all parallel chunks hit the **same** connection — bounded by one provider's rate limit / context. Spreading across providers is impossible.
3. **Manual provider juggling.** Switching between local (cheap/private) and cloud (high quality) means re-editing the single connection each time.

---

## 3. Goals / Non-Goals

### Goals

- G1. Settings UI to add/edit/remove multiple LLM connections via a `+` button.
- G2. Each connection stores its own provider, API key, model, endpoint (for local), and label.
- G3. Per-connection "Test connection" + model fetch (reuse existing `/api/models`, `/api/test-connection`).
- G4. A **mode** selector: `Single` (current behavior), `Fallback`, or `Parallel`.
- G5. Fallback: ordered list; on chunk/job failure, cascade to next enabled connection.
- G6. Parallel: distribute chunks round-robin / weighted across enabled connections.
- G7. Backward compatible: existing single-connection configs migrate automatically; default behavior unchanged.
- G8. Job tracking records which connection(s) actually did the work (for logs/debug).

### Non-Goals

- Per-task (per-target-language) connection routing — future.
- Cost tracking / budgeting per connection — future.
- Load-based dynamic routing (auto-detect fastest) — future; v1 is static order / round-robin.
- Streaming partial results across connections — out of scope.

---

## 4. Proposed Solution

### 4.1 Data model

Replace the flat per-provider keys with a **connections array** while keeping a migration path.

New setting key `llm_connections` (JSON string, matching how `scan_profiles` / `transcription_folder_defaults` are already stored as JSON strings in config):

```ts
interface LlmConnection {
  id: string;            // uuid/slug, stable
  label: string;         // user-facing name, e.g. "OpenAI GPT-4o"
  provider: "local" | "openai" | "anthropic" | "gemini";
  apiKey: string;        // empty for local if not needed
  model: string;
  endpoint: string;      // only meaningful for local/openai-compatible
  enabled: boolean;      // included in fallback/parallel pool
  order: number;         // priority for fallback; tie-break for parallel
}
```

New setting key `llm_mode`: `"single" | "fallback" | "parallel"` (default `"single"`).

For `single` mode, an `active_connection_id` points at the chosen connection (preserves today's "pick one provider" UX).

**Why JSON-in-settings, not a new DB table:** connections are config, not runtime state. Config already lives in `config.json` (`config.ts`), persisted via `setSetting`. A DB table (`db.ts`) adds migration surface for little gain. Keep parity with existing `scan_profiles` pattern.

### 4.2 Migration (backward compat)

On `loadConfig` (or first read of `llm_connections` when absent), synthesize the array from existing flat keys:

- Always create a `local` connection from `llm_endpoint` / `api_key` / `model`.
- For each of `openai|anthropic|gemini` with a non-empty `cloud_api_key_*`, create a cloud connection using `cloud_model_*`.
- Set `llm_mode = "single"` and `active_connection_id` = connection matching the old `cloud_provider`.

Flat keys remain readable (not deleted) so rollback is safe. New writes go to `llm_connections`.

### 4.3 Translation execution changes (`queue.ts` + `translator.ts`)

Replace the single derive block (`queue.ts:77-91`) with a resolved **connection pool**:

```ts
const pool = resolveConnectionPool(settings); // [{provider, apiKey, model, apiHost}, ...]
const mode = settings.llm_mode;
```

- **single** → pool = `[active]`. Behavior identical to today.
- **fallback** → pool = enabled connections sorted by `order`. Wrap `translateChunk` so that after `retryTranslate` exhausts attempts on connection N, it advances to connection N+1 before failing the job. Last connection's failure = job failure.
- **parallel** → assign chunks to connections round-robin (respecting `parallelChunks`). Each worker uses its own `getAi()` client. A chunk that fails on its assigned connection may fall back to another enabled connection (fallback-within-parallel) — v1 can keep it simple: parallel + per-chunk single-connection retry, optional fallback flag.

`translateFile` options (`TranslateFileOptions`) gain either:
- `connections: ResolvedConnection[]` + `mode`, OR
- keep `translateChunk` taking a single resolved connection and move the pool/cascade loop into a wrapper (`translateFileMulti`). **Preferred:** wrapper, to minimize churn in `translateChunk`.

### 4.4 API endpoints (`src/server/index.ts`)

Minimal addition — reuse settings persistence:

- `llm_connections` and `llm_mode` ride through existing `GET/POST /api/settings` (no new CRUD endpoints needed; client sends the full array). Keeps server surface tiny.
- Extend `POST /api/test-connection` to accept `{ provider, apiKey, model, endpoint }` so any connection (not just local) can be tested. **Fixes existing bug** where it only tests local (`index.ts:731-741`).
- `GET /api/models` already accepts `?provider=`; extend to also accept an explicit key/endpoint so a not-yet-saved connection can fetch models.

### 4.5 Settings UI (`SettingsPage.tsx`)

Replace the single "LLM Connection" panel (lines ~156-316) with a **Connections** section:

- A **mode** segmented control: `Single | Fallback | Parallel` with one-line helper text each.
- A list of connection cards. Each card: label, provider selector, API key, model dropdown (+ fetch button), endpoint (local only), enabled toggle, Test button + health dot, delete (trash).
- A `+ Add connection` button appends a new blank card.
- Drag handle (or up/down arrows) to set `order` (fallback priority). Defer drag-drop to keep v1 simple → use ↑/↓ buttons.
- `single` mode: radio-select which connection is active (others greyed).

Reuse existing pieces: provider buttons, model-fetch flow, health check display, temperature slider stays global under Translation Engine.

---

## 5. UX Flows

### Add a 2nd connection
1. Settings → Connections → `+ Add connection`.
2. New card appears; pick provider, paste key, fetch models, pick model, label it.
3. Click Test → green dot.
4. Choose mode (Fallback/Parallel). Save.

### Fallback in action
- Job starts on connection #1 (OpenAI). OpenAI returns 429 → `retryTranslate` exhausts → cascade to #2 (Anthropic) → succeeds. Logs note the provider switch; job records `used_connections`.

### Parallel in action
- 60 chunks, 3 enabled connections, `parallel_chunks` honored per connection. Chunks round-robin across the 3. Wall-clock ≈ time of slowest third.

---

## 6. Edge Cases & Risks

| Case | Handling |
|------|----------|
| All connections disabled | Block save / fall back to local default; surface validation error. |
| Single connection but mode=parallel | Degrades to single (no error). |
| Mixed local + cloud in parallel | Allowed; each worker uses correct `getAi()` per provider. |
| Connection edited mid-job | Job snapshots pool at start (already true today — settings read once at job start, `queue.ts:69`). |
| API key empty for cloud connection | Mark connection invalid; exclude from pool; warn in UI. |
| Different models → inconsistent translation quality | Document tradeoff; fallback is for resilience, parallel for speed. User's choice. |
| Secrets in `config.json` | Already stored plaintext today (`cloud_api_key_*`). No regression; note for future secret-manager work. |
| Ordering / tie in parallel | Round-robin by `order`. |

---

## 7. Implementation Plan (phased)

**Phase 1 — Data model + migration (server)**
- Add `llm_connections`, `llm_mode`, `active_connection_id` defaults (`config.ts`).
- `resolveConnectionPool(settings)` helper + migration from flat keys.
- Unit tests: migration produces correct array; single mode == legacy.

**Phase 2 — Execution (server)**
- `translateFileMulti` wrapper implementing single/fallback/parallel over `translateChunk`.
- Wire `queue.ts` to use pool + mode; record `used_connections` on job.
- Extend `/api/test-connection` and `/api/models` for arbitrary connection.

**Phase 3 — Settings UI (client)**
- Connections list, `+ add`, per-card edit/test/delete, mode control, ↑/↓ order.
- Migrate existing single-panel state to array-backed state.

**Phase 4 — Polish**
- Job detail shows which connection(s) ran.
- Docs/README update.

---

## 8. Open Questions

1. **Parallel granularity:** split by chunk (fine) vs by file (coarse, simpler)? Recommend chunk-level, reusing existing `parallelChunks` worker pool.
2. **Per-connection rate limit / weight:** v1 equal round-robin, or expose a `weight` field now? Recommend defer.
3. **Fallback trigger scope:** cascade per-chunk (chunk N fails → try next provider for that chunk) vs per-job (whole job fails → restart on next)? Recommend per-chunk for least wasted work.
4. **Should `single` mode UI even keep multiple saved connections?** Yes — lets users keep configs and just switch the radio. Strong UX win.
5. Keep flat `cloud_*` keys forever, or remove after a migration window? Recommend keep through v1, deprecate later.

---

## 9. Acceptance Criteria

- [ ] User can add ≥3 connections via `+` in Settings and persist them.
- [ ] Each connection independently testable; model fetch works per connection.
- [ ] Mode = Single reproduces current behavior exactly (regression-safe).
- [ ] Mode = Fallback: killing/erroring connection #1 results in job completing via #2 (verified in logs).
- [ ] Mode = Parallel: a multi-chunk job distributes chunks across ≥2 connections; total time drops vs single.
- [ ] Existing configs auto-migrate with zero user action; no data loss.
- [ ] Job record shows which connection(s) performed the translation.
