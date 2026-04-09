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

export function forceJob(id: number) {
  db.prepare(
    "UPDATE jobs SET status = 'pending', force = 1, completed_cues = 0, error = NULL, duration_seconds = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
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

export function clearJobs() {
  db.prepare("DELETE FROM jobs").run();
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
