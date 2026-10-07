import db from "./db.js";
import { estimateCost } from "./pricing.js";
import { readSettings } from "./settings-schema.js";
import type { ResolvedConnection } from "./connections.js";
import type { TokenUsage } from "./translator.js";
import type { LlmProvider } from "../shared/llm.js";
import type {
  UsageBudget,
  UsageByKind,
  UsageByModel,
  UsageCall,
  UsageDay,
  UsageFile,
  UsageKind,
  UsageRange,
  UsageReport,
  UsageTotals,
} from "../shared/usage.js";

// Append-only ledger: one row per successful LLM call. Unlike the per-job
// counters it outlives the job, so history survives clearing the queue, and
// job_id may name a job that no longer exists.
// No release has written this table, so a dev DB from before `src` is rebuilt rather than migrated.
const usageColumns = db.prepare("PRAGMA table_info(llm_usage)").all() as Array<{ name: string }>;
if (usageColumns.length > 0 && !usageColumns.some((c) => c.name === "src")) db.exec("DROP TABLE llm_usage");
db.exec(`
  CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    job_id INTEGER,
    src TEXT NOT NULL,
    srt_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    connection_label TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage (ts)");
db.exec("CREATE INDEX IF NOT EXISTS idx_llm_usage_model ON llm_usage (provider, model)");

export interface UsageEntry extends TokenUsage {
  kind: UsageKind;
  connection: Pick<ResolvedConnection, "id" | "label" | "provider" | "model">;
  jobId: number | null;
  /** Identifies the file across jobs: the subtitle's path, or the upload's name for Convert. */
  src: string;
  srtName: string;
  ts?: Date;
}

const insertRow = db.prepare(`
  INSERT INTO llm_usage (ts, job_id, src, srt_name, kind, connection_id, connection_label, provider, model,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Appends one call, priced now with the model that ran it (null for local or unpriced models). */
export function recordUsage(entry: UsageEntry): void {
  const { connection: conn } = entry;
  const provider: LlmProvider = conn.provider ?? "local";
  const cost = provider === "local" ? null : estimateCost(conn.model, entry.inputTokens, entry.outputTokens);
  insertRow.run(
    (entry.ts ?? new Date()).toISOString(),
    entry.jobId,
    entry.src,
    entry.srtName,
    entry.kind,
    conn.id,
    conn.label,
    provider,
    conn.model,
    entry.inputTokens,
    entry.outputTokens,
    entry.cacheReadTokens,
    entry.cacheWriteTokens,
    entry.reasoningTokens,
    cost,
  );
}

/** Empties the ledger; returns how many calls were removed. */
export function clearUsage(): number {
  return db.prepare("DELETE FROM llm_usage").run().changes;
}

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<Exclude<UsageRange, "all">, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
const TOP_FILES = 10;
const RECENT_CALLS = 50;

// Shared aggregate columns; SUM over cost_usd skips NULLs and is NULL only when every row is.
const TOKEN_SUMS = `COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens, SUM(cost_usd) AS costUsd`;
const BY_TOTAL = "ORDER BY SUM(input_tokens + output_tokens) DESC";
const LIVE_JOB_ID = "(SELECT j.id FROM jobs j WHERE j.id = u.job_id)";

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Every UTC day from `first` to `last` inclusive, missing days as zeros. */
function fillDays(rows: UsageDay[], first: Date, last: Date): UsageDay[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days: UsageDay[] = [];
  for (let t = startOfUtcDay(first).getTime(); t <= last.getTime(); t += DAY_MS) {
    const day = dayOf(new Date(t));
    days.push(byDay.get(day) ?? { day, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null });
  }
  return days;
}

function monthBudget(now: Date): UsageBudget | null {
  const monthlyTokens = readSettings().monthly_token_budget;
  if (monthlyTokens <= 0) return null;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, SUM(cost_usd) AS cost FROM llm_usage WHERE ts >= ?",
    )
    .get(monthStart) as { tokens: number; cost: number | null };
  return { monthlyTokens, monthTokens: row.tokens, monthCostUsd: row.cost, monthStart };
}

/** The ledger summarised over `range`, ending now. */
export function buildUsageReport(range: UsageRange, now: Date = new Date()): UsageReport {
  const from = range === "all" ? null : new Date(startOfUtcDay(now).getTime() - (RANGE_DAYS[range] - 1) * DAY_MS);
  const where = from ? "WHERE ts >= @from" : "";
  const params = from ? { from: from.toISOString() } : {};
  const all = <T>(sql: string) => db.prepare(sql).all(params) as T[];

  const totals = db
    .prepare(
      `SELECT ${TOKEN_SUMS},
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
        COUNT(DISTINCT job_id) AS jobs, COUNT(DISTINCT src) AS files
      FROM llm_usage ${where}`,
    )
    .get(params) as Omit<UsageTotals, "totalTokens">;

  const dayRows = all<UsageDay>(
    `SELECT substr(ts, 1, 10) AS day, ${TOKEN_SUMS} FROM llm_usage ${where} GROUP BY day ORDER BY day`,
  );
  const firstDay = from ?? (dayRows[0] ? new Date(`${dayRows[0].day}T00:00:00Z`) : null);

  return {
    range,
    from: from?.toISOString() ?? null,
    to: now.toISOString(),
    totals: { ...totals, totalTokens: totals.inputTokens + totals.outputTokens },
    budget: monthBudget(now),
    daily: firstDay ? fillDays(dayRows, firstDay, now) : [],
    // The label of the connection's latest call: SQLite takes bare columns from the MAX(id) row.
    byModel: all<UsageByModel & { latest: number }>(
      `SELECT provider, model, connection_label AS connectionLabel, MAX(id) AS latest, ${TOKEN_SUMS}
      FROM llm_usage ${where} GROUP BY provider, model, connection_id ${BY_TOTAL}`,
    ).map(({ latest: _, ...row }) => row),
    byKind: all<UsageByKind>(`SELECT kind, ${TOKEN_SUMS} FROM llm_usage ${where} GROUP BY kind ${BY_TOTAL}`),
    // jobId links only to jobs that still exist; a file's row links to its newest one.
    topFiles: all<UsageFile>(
      `SELECT MAX(${LIVE_JOB_ID}) AS jobId, srt_name AS srtName, ${TOKEN_SUMS}
      FROM llm_usage u ${where} GROUP BY src ${BY_TOTAL} LIMIT ${TOP_FILES}`,
    ),
    recent: all<UsageCall>(
      `SELECT ts, ${LIVE_JOB_ID} AS jobId, srt_name AS srtName, kind, model, input_tokens AS inputTokens,
        output_tokens AS outputTokens, cost_usd AS costUsd
      FROM llm_usage u ${where} ORDER BY ts DESC, id DESC LIMIT ${RECENT_CALLS}`,
    ),
  };
}
