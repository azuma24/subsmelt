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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(srt_path, task_id)
  )
`);

// Schema migration for existing DBs
const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
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

// Wire up logger
setLogDb(db);

// On startup, reset stuck "translating" jobs
db.prepare("UPDATE jobs SET status = 'pending', updated_at = datetime('now') WHERE status = 'translating'").run();

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
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(job.task_id, job.srt_path, job.output_path, job.video_path, job.status || "pending");
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
  }>
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
export function addJobUsage(id: number, inputDelta: number, outputDelta: number) {
  const inDelta = Number.isFinite(inputDelta) ? Math.max(0, Math.trunc(inputDelta)) : 0;
  const outDelta = Number.isFinite(outputDelta) ? Math.max(0, Math.trunc(outputDelta)) : 0;
  if (inDelta === 0 && outDelta === 0) return;
  db.prepare(
    "UPDATE jobs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ? WHERE id = ?"
  ).run(inDelta, outDelta, id);
}

export function getJobs(status?: string) {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC`
      )
      .all(status);
  }
  return db
    .prepare(`SELECT * FROM jobs ORDER BY priority DESC, created_at DESC`)
    .all();
}

export function getJob(id: number) {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
}

export function getJobBySrtAndTask(srtPath: string, taskId: number) {
  return db.prepare("SELECT * FROM jobs WHERE srt_path = ? AND task_id = ?").get(srtPath, taskId);
}

export function resetJob(id: number) {
  db.prepare(
    "UPDATE jobs SET status = 'pending', completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function resetJobs(ids: number[]) {
  const cleanIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (cleanIds.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE jobs SET status = 'pending', completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'error'"
  );
  let updated = 0;
  const tx = db.transaction(() => {
    for (const id of cleanIds) updated += stmt.run(id).changes;
  });
  tx();
  return updated;
}

export function forceJob(id: number) {
  db.prepare(
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function forceJobs(ids: number[]) {
  const cleanIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (cleanIds.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('done', 'skipped')"
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
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, used_connections = NULL, updated_at = datetime('now') WHERE status IN ('done', 'skipped')"
  ).run();
}

export function pinJob(id: number) {
  const max = db.prepare("SELECT MAX(priority) as m FROM jobs").get() as any;
  const newPriority = (max?.m || 0) + 1;
  db.prepare("UPDATE jobs SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(newPriority, id);
}

export function unpinJob(id: number) {
  db.prepare("UPDATE jobs SET priority = 0, updated_at = datetime('now') WHERE id = ?").run(id);
}

export function reorderJobs(jobIds: number[]) {
  const stmt = db.prepare("UPDATE jobs SET priority = ?, updated_at = datetime('now') WHERE id = ?");
  const tx = db.transaction(() => {
    for (let i = 0; i < jobIds.length; i++) {
      stmt.run(jobIds.length - i, jobIds[i]);
    }
  });
  tx();
}

export function deleteJob(id: number) {
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
}

export function deleteJobs(ids: number[]) {
  const cleanIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (cleanIds.length === 0) return 0;

  const stmt = db.prepare("DELETE FROM jobs WHERE id = ? AND status = 'pending'");
  let deleted = 0;
  const tx = db.transaction(() => {
    for (const id of cleanIds) {
      deleted += stmt.run(id).changes;
    }
  });
  tx();
  return deleted;
}

export function clearJobs() {
  db.prepare("DELETE FROM jobs").run();
}

// --- Logs ---

export function getLogs(opts?: {
  level?: string;
  category?: string;
  jobId?: number;
  limit?: number;
  offset?: number;
}) {
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

  return db.prepare(sql).all(...vals);
}

export function clearLogs() {
  db.prepare("DELETE FROM logs").run();
}

export default db;
