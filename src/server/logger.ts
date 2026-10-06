import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/** Structured context stored beside a log line (a stage name, a status, a snippet). */
export type LogMeta = Record<string, unknown>;

const DATA_DIR = process.env.DATA_DIR || "./data";
fs.mkdirSync(DATA_DIR, { recursive: true });

const LOG_FILE = path.join(DATA_DIR, "app.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 3;

// TZ is respected automatically by Node.js when set as env var.
// e.g. TZ=Asia/Taipei will make new Date().toLocaleString() use that timezone.
// We store ISO strings in UTC in the DB, but display with local TZ in the log file.

function nowISO(): string {
  return new Date().toISOString();
}

function nowLocal(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: process.env.TZ || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// DB will be injected after db.ts initializes to avoid circular deps
let _db: Database.Database | null = null;
// Entries logged before then (config.json failing to load, say) wait here so
// the Logs page still shows them.
const MAX_EARLY_ENTRIES = 100;
const earlyEntries: DbEntry[] = [];

export function setLogDb(db: Database.Database) {
  _db = db;
  for (const entry of earlyEntries.splice(0)) writeToDB(entry);
}

function rotateLogFile() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return;
  }

  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const from = `${LOG_FILE}.${i}`;
    const to = `${LOG_FILE}.${i + 1}`;
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {}
  }
  try {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
}

function writeToFile(entry: {
  timestamp: string;
  level: string;
  category: string;
  message: string;
  job_id?: number | null;
  meta?: LogMeta;
}) {
  rotateLogFile();
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(LOG_FILE, line, "utf8");
}

interface DbEntry {
  timestamp: string;
  level: string;
  category: string;
  message: string;
  job_id?: number | null;
  meta?: LogMeta;
}

function writeToDB(entry: DbEntry) {
  if (!_db) {
    if (earlyEntries.length < MAX_EARLY_ENTRIES) earlyEntries.push(entry);
    return;
  }
  try {
    _db
      .prepare(
        `INSERT INTO logs (timestamp, level, category, message, job_id, meta)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.timestamp,
        entry.level,
        entry.category,
        entry.message,
        entry.job_id ?? null,
        entry.meta ? JSON.stringify(entry.meta) : null,
      );
  } catch {}
}

type LogLevel = "info" | "warn" | "error";
type LogCategory = "scan" | "translate" | "queue" | "system" | "youtube";

function log(level: LogLevel, category: LogCategory, message: string, jobId?: number | null, meta?: LogMeta) {
  const isoTimestamp = nowISO();
  const localTimestamp = nowLocal();

  const entry = {
    timestamp: isoTimestamp,
    level,
    category,
    message,
    job_id: jobId ?? null,
    meta,
  };

  // Console (local time)
  const prefix = `[${localTimestamp}] [${level.toUpperCase()}] [${category}]`;
  if (level === "error") {
    console.error(`${prefix} ${message}`);
  } else if (level === "warn") {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }

  // File (includes both timestamps)
  writeToFile({ ...entry, meta: { ...(entry.meta || {}), local_time: localTimestamp } });

  // DB (ISO/UTC)
  writeToDB(entry);
}

export const logger = {
  info: (category: LogCategory, message: string, jobId?: number | null, meta?: LogMeta) =>
    log("info", category, message, jobId, meta),
  warn: (category: LogCategory, message: string, jobId?: number | null, meta?: LogMeta) =>
    log("warn", category, message, jobId, meta),
  error: (category: LogCategory, message: string, jobId?: number | null, meta?: LogMeta) =>
    log("error", category, message, jobId, meta),
};

export function getLogFilePath() {
  return LOG_FILE;
}
