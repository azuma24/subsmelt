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
    duration_seconds REAL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(srt_path, task_id)
  )
`);

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

// --- Schema: Transcription jobs ---
//
// Single table serves two kinds:
//   kind='transcribe'  — video → subtitle
//   kind='download'    — pre-pulling a model from the Whisper backend
// Progress / stage / error plumbing is shared so SSE + UI code stays uniform.
db.exec(`
  CREATE TABLE IF NOT EXISTS transcription_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'transcribe',
    video_path TEXT,
    output_path TEXT,
    output_format TEXT,
    model_kind TEXT,
    model_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    stage TEXT,
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    whisper_task_id TEXT,
    options_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Wire up logger
setLogDb(db);

// On startup, reset stuck "translating" jobs
db.prepare("UPDATE jobs SET status = 'pending', updated_at = datetime('now') WHERE status = 'translating'").run();

// Reset any transcription jobs that were mid-flight when the process died — the
// remote Whisper backend is the source of truth and we'll re-sync from it, but
// any jobs that never even left our side should go back to pending.
db.prepare(
  "UPDATE transcription_jobs SET status = 'pending', updated_at = datetime('now') " +
    "WHERE status = 'running' AND whisper_task_id IS NULL"
).run();

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
    duration_seconds: number;
    force: number;
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
    "UPDATE jobs SET status = 'pending', completed_cues = 0, error = NULL, duration_seconds = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function resetJobs(ids: number[]) {
  const cleanIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (cleanIds.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE jobs SET status = 'pending', completed_cues = 0, error = NULL, duration_seconds = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'error'"
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
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function forceJobs(ids: number[]) {
  const cleanIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (cleanIds.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('done', 'skipped')"
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
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, updated_at = datetime('now') WHERE status IN ('done', 'skipped')"
  ).run();
}

export function pinJob(id: number) {
  const max = db.prepare("SELECT MAX(priority) as m FROM jobs").get() as any;
  const newPriority = (max?.m || 0) + 1;
  db.prepare("UPDATE jobs SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(newPriority, id);
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

// --- Transcription jobs ---

export interface TranscriptionJobRow {
  id: number;
  kind: string;
  video_path: string | null;
  output_path: string | null;
  output_format: string | null;
  model_kind: string | null;
  model_name: string | null;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  whisper_task_id: string | null;
  options_json: string | null;
  created_at: string;
  updated_at: string;
}

export function createTranscriptionJob(job: {
  kind: string;
  video_path?: string | null;
  output_path?: string | null;
  output_format?: string | null;
  model_kind?: string | null;
  model_name?: string | null;
  options_json?: string | null;
}) {
  return db
    .prepare(
      `INSERT INTO transcription_jobs
         (kind, video_path, output_path, output_format, model_kind, model_name, options_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(
      job.kind,
      job.video_path ?? null,
      job.output_path ?? null,
      job.output_format ?? null,
      job.model_kind ?? null,
      job.model_name ?? null,
      job.options_json ?? null
    );
}

export function getTranscriptionJob(id: number): TranscriptionJobRow | undefined {
  return db
    .prepare("SELECT * FROM transcription_jobs WHERE id = ?")
    .get(id) as TranscriptionJobRow | undefined;
}

export function listTranscriptionJobs(filter?: { kind?: string; status?: string; limit?: number }): TranscriptionJobRow[] {
  let sql = "SELECT * FROM transcription_jobs WHERE 1=1";
  const vals: unknown[] = [];
  if (filter?.kind) {
    sql += " AND kind = ?";
    vals.push(filter.kind);
  }
  if (filter?.status) {
    sql += " AND status = ?";
    vals.push(filter.status);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  vals.push(filter?.limit ?? 200);
  return db.prepare(sql).all(...vals) as TranscriptionJobRow[];
}

export function listActiveTranscriptionJobs(): TranscriptionJobRow[] {
  return db
    .prepare(
      "SELECT * FROM transcription_jobs WHERE status IN ('pending','running') ORDER BY created_at ASC"
    )
    .all() as TranscriptionJobRow[];
}

export function updateTranscriptionJob(
  id: number,
  updates: Partial<{
    status: string;
    stage: string | null;
    progress: number;
    error: string | null;
    whisper_task_id: string | null;
  }>
) {
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  vals.push(id);
  db.prepare(`UPDATE transcription_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function deleteTranscriptionJob(id: number) {
  db.prepare("DELETE FROM transcription_jobs WHERE id = ?").run(id);
}

export function findActiveTranscriptionForVideo(videoPath: string): TranscriptionJobRow | undefined {
  return db
    .prepare(
      "SELECT * FROM transcription_jobs WHERE video_path = ? AND kind = 'transcribe' " +
        "AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1"
    )
    .get(videoPath) as TranscriptionJobRow | undefined;
}

// --- Logs ---

export function getLogs(opts?: {
  level?: string;
  category?: string;
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
