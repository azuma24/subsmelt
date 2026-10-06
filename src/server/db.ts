import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { setLogDb } from "./logger.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "subsmelt.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Schema: Jobs ---

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    srt_path TEXT NOT NULL,
    output_path TEXT NOT NULL,
    video_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 0,
    force INTEGER NOT NULL DEFAULT 0,
    total_cues INTEGER DEFAULT 0,
    completed_cues INTEGER DEFAULT 0,
    error TEXT,
    analysis_context TEXT,
    duration_seconds REAL,
    started_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(srt_path, task_id)
  )
`);

// Schema migration for existing DBs
const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{
  name: string;
}>;
if (!jobColumns.some((c) => c.name === "analysis_context")) {
  db.exec("ALTER TABLE jobs ADD COLUMN analysis_context TEXT");
}
if (!jobColumns.some((c) => c.name === "used_connections")) {
  db.exec("ALTER TABLE jobs ADD COLUMN used_connections TEXT");
}
// Token/cost tracking — accumulated per job as the LLM reports usage.
if (!jobColumns.some((c) => c.name === "input_tokens")) {
  db.exec("ALTER TABLE jobs ADD COLUMN input_tokens INTEGER DEFAULT 0");
}
if (!jobColumns.some((c) => c.name === "output_tokens")) {
  db.exec("ALTER TABLE jobs ADD COLUMN output_tokens INTEGER DEFAULT 0");
}
// When the job was claimed. updated_at moves on every progress write, so it
// cannot serve as a start time — without this there is no elapsed to project an
// ETA from.
if (!jobColumns.some((c) => c.name === "started_at")) {
  db.exec("ALTER TABLE jobs ADD COLUMN started_at TEXT");
}

// Queue workers claim pending jobs by status/priority rather than materializing
// the full pending table on every poll.
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_jobs_pending_priority ON jobs (status, priority DESC, created_at ASC, id ASC)",
);
// The dashboard list sorts every job by priority/recency; the status-leading
// index above cannot serve that ordering, so it would be a full scan plus a
// temporary b-tree per request.
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_jobs_list_order ON jobs (priority DESC, created_at DESC, id DESC)",
);

// --- Schema: Logs ---

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    job_id INTEGER,
    meta TEXT
  )
`);
// The logs view filters by job id most often (open-logs from a job row);
// without this it reverse-scans the whole append-only table.
db.exec("CREATE INDEX IF NOT EXISTS idx_logs_job_id ON logs (job_id, id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level, id)");

// Wire up logger
setLogDb(db);

// Jobs the previous process left translating go back to pending. Nothing
// resumes from the partial, so their progress count goes back to zero too.
export function resetInterruptedJobs(): number {
  return db
    .prepare(
      "UPDATE jobs SET status = 'pending', completed_cues = 0, updated_at = datetime('now') WHERE status = 'translating'",
    )
    .run().changes;
}
resetInterruptedJobs();

// --- Row types ---

/** Shape of a `jobs` row as stored in SQLite. */
export interface JobRow {
  id: number;
  task_id: number;
  srt_path: string;
  output_path: string;
  video_path: string | null;
  status: string;
  priority: number;
  force: number;
  total_cues: number | null;
  completed_cues: number | null;
  error: string | null;
  analysis_context: string | null;
  used_connections: string | null;
  duration_seconds: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Shape of a `logs` row as stored in SQLite. */
export interface LogRow {
  id: number;
  timestamp: string;
  level: string;
  category: string;
  message: string;
  job_id: number | null;
  meta: string | null;
}

// --- Jobs ---

export function createJob(job: {
  task_id: number;
  srt_path: string;
  output_path: string;
  video_path: string | null;
  status?: string;
}) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO jobs (task_id, srt_path, output_path, video_path, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      job.task_id,
      job.srt_path,
      job.output_path,
      job.video_path,
      job.status || "pending",
    );
}

export function updateJob(
  id: number,
  updates: Partial<{
    status: string;
    total_cues: number;
    completed_cues: number;
    error: string | null;
    analysis_context: string | null;
    used_connections: string | null;
    duration_seconds: number;
    force: number;
    input_tokens: number;
    output_tokens: number;
    output_path: string;
  }>,
) {
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  vals.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/**
 * Increment a job's accumulated token usage. Called per LLM call as usage is
 * reported, so the totals build up while the job runs. Deltas are coerced to
 * finite non-negative integers; a no-op when both are zero.
 */
export function addJobUsage(
  id: number,
  inputDelta: number,
  outputDelta: number,
) {
  const inDelta = Number.isFinite(inputDelta)
    ? Math.max(0, Math.trunc(inputDelta))
    : 0;
  const outDelta = Number.isFinite(outputDelta)
    ? Math.max(0, Math.trunc(outputDelta))
    : 0;
  if (inDelta === 0 && outDelta === 0) return;
  db.prepare(
    "UPDATE jobs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ? WHERE id = ?",
  ).run(inDelta, outDelta, id);
}

export function getJobs(status?: string): JobRow[] {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC`,
      )
      .all(status) as JobRow[];
  }
  return db
    .prepare(`SELECT * FROM jobs ORDER BY priority DESC, created_at DESC`)
    .all() as JobRow[];
}

/** The dashboard list: every column except analysis_context, which is a
 *  KB-scale blob only the preview endpoint reads. Shipping it for every row
 *  of every poll inflated the payload for nothing. */
const JOB_LIST_COLUMNS =
  "id, task_id, srt_path, output_path, video_path, status, priority, force, total_cues, completed_cues, error, duration_seconds, started_at, created_at, updated_at, input_tokens, output_tokens, used_connections";

export function getJobsForList(): JobRow[] {
  return db
    .prepare(
      `SELECT ${JOB_LIST_COLUMNS} FROM jobs ORDER BY priority DESC, created_at DESC`,
    )
    .all() as JobRow[];
}

/** One row per (source subtitle, task) with its job state, for the scanner to
 *  match against in memory instead of one query per subtitle per task. */
export function listJobTaskStatuses(): Array<{
  id: number;
  srt_path: string;
  output_path: string;
  task_id: number;
  status: string;
}> {
  return db
    .prepare("SELECT id, srt_path, output_path, task_id, status FROM jobs")
    .all() as Array<{ id: number; srt_path: string; output_path: string; task_id: number; status: string }>;
}

/** A job that has not finished and would write `outputPath`, other than `exceptId`. */
export function findUnfinishedJobForOutput(outputPath: string, exceptId: number | null): { id: number } | undefined {
  return db
    .prepare(
      "SELECT id FROM jobs WHERE output_path = ? AND status NOT IN ('done', 'skipped') AND id != ? LIMIT 1",
    )
    .get(outputPath, exceptId ?? -1) as { id: number } | undefined;
}

/** The job for one (source subtitle, task) pair, which the jobs table keeps unique. */
export function findJobForTask(srtPath: string, taskId: number): { id: number; task_id: number; status: string } | undefined {
  return db
    .prepare("SELECT id, task_id, status FROM jobs WHERE srt_path = ? AND task_id = ?")
    .get(srtPath, taskId) as { id: number; task_id: number; status: string } | undefined;
}

/** srt_path and status only — folder counts never need the other columns. */
export function listJobPathsAndStatuses(): Array<{ srt_path: string; status: string }> {
  return db
    .prepare("SELECT srt_path, status FROM jobs")
    .all() as Array<{ srt_path: string; status: string }>;
}

export function countPendingJobs(ids?: Set<number> | null): number {
  if (!ids || ids.size === 0) {
    return (
      db
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'")
        .get() as { count: number }
    ).count;
  }
  const values = Array.from(ids);
  const placeholders = values.map(() => "?").join(",");
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending' AND id IN (${placeholders})`,
      )
      .get(...values) as { count: number }
  ).count;
}

export function claimPendingJob(ids?: Set<number> | null): JobRow | null {
  const values = ids && ids.size > 0 ? Array.from(ids) : [];
  const filter =
    values.length > 0 ? ` AND id IN (${values.map(() => "?").join(",")})` : "";
  const select = db.prepare(
    `SELECT * FROM jobs WHERE status = 'pending'${filter} ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1`,
  );
  const claim = db.prepare(
    "UPDATE jobs SET status = 'translating', error = NULL, analysis_context = NULL, used_connections = NULL, input_tokens = 0, output_tokens = 0, started_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
  );
  return db.transaction(() => {
    const job = select.get(...values) as JobRow | undefined;
    if (!job || claim.run(job.id).changes !== 1) return null;
    return job;
  })();
}

/** Jobs translating `srtPath` that have not settled yet: pending or translating. */
export function countOpenJobsForSubtitle(srtPath: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE srt_path = ? AND status IN ('pending', 'translating')",
      )
      .get(srtPath) as { count: number }
  ).count;
}

export function getJob(id: number): JobRow | undefined {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
    | JobRow
    | undefined;
}

export function getJobBySrtAndTask(
  srtPath: string,
  taskId: number,
): JobRow | undefined {
  return db
    .prepare("SELECT * FROM jobs WHERE srt_path = ? AND task_id = ?")
    .get(srtPath, taskId) as JobRow | undefined;
}

// The single-job variants return the affected row count (0 or 1) like the batch
// ones. A translating job is refused: handing it back to the queue lets a second
// worker claim it while the first still runs, and both then write the same .part.
/** Return a job to pending; `outputPath` re-targets it when its task's naming changed since it was created. */
export function resetJob(id: number, outputPath?: string): number {
  return db
    .prepare(
      "UPDATE jobs SET status = 'pending', completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, output_path = COALESCE(?, output_path), updated_at = datetime('now') WHERE id = ? AND status != 'translating'",
    )
    .run(outputPath ?? null, id).changes;
}

export function resetJobs(ids: number[]) {
  const cleanIds = Array.from(
    new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
  );
  if (cleanIds.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE jobs SET status = 'pending', completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'error'",
  );
  let updated = 0;
  const tx = db.transaction(() => {
    for (const id of cleanIds) updated += stmt.run(id).changes;
  });
  tx();
  return updated;
}

export function forceJob(id: number): number {
  return db
    .prepare(
      "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE id = ? AND status != 'translating'",
    )
    .run(id).changes;
}

export function forceJobs(ids: number[]) {
  const cleanIds = Array.from(
    new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
  );
  if (cleanIds.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('done', 'skipped')",
  );
  let updated = 0;
  const tx = db.transaction(() => {
    for (const id of cleanIds) updated += stmt.run(id).changes;
  });
  tx();
  return updated;
}

export function forceAllJobs() {
  db.prepare(
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE status IN ('done', 'skipped')",
  ).run();
}

export function pinJob(id: number) {
  const max = db.prepare("SELECT MAX(priority) as m FROM jobs").get() as any;
  const newPriority = (max?.m || 0) + 1;
  db.prepare(
    "UPDATE jobs SET priority = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(newPriority, id);
}

export function unpinJob(id: number) {
  db.prepare(
    "UPDATE jobs SET priority = 0, updated_at = datetime('now') WHERE id = ?",
  ).run(id);
}

export function reorderJobs(jobIds: number[]) {
  const stmt = db.prepare(
    "UPDATE jobs SET priority = ?, updated_at = datetime('now') WHERE id = ?",
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < jobIds.length; i++) {
      stmt.run(jobIds.length - i, jobIds[i]);
    }
  });
  tx();
}

export function deleteJob(id: number): number {
  return db
    .prepare("DELETE FROM jobs WHERE id = ? AND status != 'translating'")
    .run(id).changes;
}

export function deleteJobs(ids: number[]) {
  const cleanIds = Array.from(
    new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
  );
  if (cleanIds.length === 0) return 0;

  const stmt = db.prepare(
    "DELETE FROM jobs WHERE id = ? AND status = 'pending'",
  );
  let deleted = 0;
  const tx = db.transaction(() => {
    for (const id of cleanIds) {
      deleted += stmt.run(id).changes;
    }
  });
  tx();
  return deleted;
}

// Pending and translating jobs stay: a worker may hold one, and deleting its
// row would hide work that is still running.
export function clearFinishedJobs(): number {
  return db
    .prepare("DELETE FROM jobs WHERE status IN ('done', 'skipped', 'error')")
    .run().changes;
}

export function deletePendingJobsForTask(taskId: number): number {
  return db
    .prepare("DELETE FROM jobs WHERE task_id = ? AND status = 'pending'")
    .run(taskId).changes;
}

// --- Logs ---

export function getLogs(opts?: {
  level?: string;
  category?: string;
  jobId?: number;
  limit?: number;
  offset?: number;
}): LogRow[] {
  let sql = "SELECT * FROM logs WHERE 1=1";
  const vals: any[] = [];

  if (opts?.level) {
    sql += " AND level = ?";
    vals.push(opts.level);
  }
  if (opts?.category) {
    sql += " AND category = ?";
    vals.push(opts.category);
  }
  if (typeof opts?.jobId === "number" && Number.isFinite(opts.jobId)) {
    sql += " AND job_id = ?";
    vals.push(opts.jobId);
  }

  sql += " ORDER BY id DESC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    vals.push(opts.limit);
  }
  if (opts?.offset) {
    sql += " OFFSET ?";
    vals.push(opts.offset);
  }

  return db.prepare(sql).all(...vals) as LogRow[];
}

export function clearLogs() {
  db.prepare("DELETE FROM logs").run();
}

// The logs table only ever grows otherwise. A month covers any job the user
// still asks about; the row cap bounds a noisy month (a looping error).
export const LOG_RETENTION_DAYS = 30;
export const LOG_MAX_ROWS = 50_000;
const LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Deletes logs older than `maxAgeDays` and all but the newest `maxRows`; returns how many went. */
export function pruneLogs({
  now = Date.now(),
  maxAgeDays = LOG_RETENTION_DAYS,
  maxRows = LOG_MAX_ROWS,
}: { now?: number; maxAgeDays?: number; maxRows?: number } = {}): number {
  const cutoff = new Date(now - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const byAge = db.prepare("DELETE FROM logs WHERE timestamp < ?").run(cutoff).changes;
  const byCount = db
    .prepare("DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)")
    .run(maxRows).changes;
  return byAge + byCount;
}

function pruneLogsSafely(): void {
  try {
    pruneLogs();
  } catch (e) {
    console.error("[Logs] Pruning old logs failed:", e);
  }
}

pruneLogsSafely();
setInterval(pruneLogsSafely, LOG_PRUNE_INTERVAL_MS).unref();

export default db;
