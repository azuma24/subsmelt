import fs from "node:fs";
import path from "node:path";

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
let _db: any = null;

export function setLogDb(db: any) {
  _db = db;
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
  meta?: any;
}) {
  rotateLogFile();
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(LOG_FILE, line, "utf8");
}

function writeToDB(entry: {
  timestamp: string;
  level: string;
  category: string;
  message: string;
  job_id?: number | null;
  meta?: any;
}) {
  if (!_db) return;
  try {
    _db
      .prepare(
        `INSERT INTO logs (timestamp, level, category, message, job_id, meta)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.timestamp,
        entry.level,
        entry.category,
        entry.message,
        entry.job_id ?? null,
        entry.meta ? JSON.stringify(entry.meta) : null
      );
  } catch {}
}

type LogLevel = "info" | "warn" | "error";
type LogCategory = "scan" | "translate" | "queue" | "system";

function log(
  level: LogLevel,
  category: LogCategory,
  message: string,
  jobId?: number | null,
  meta?: any
) {
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
  info: (category: LogCategory, message: string, jobId?: number | null, meta?: any) =>
    log("info", category, message, jobId, meta),
  warn: (category: LogCategory, message: string, jobId?: number | null, meta?: any) =>
    log("warn", category, message, jobId, meta),
  error: (category: LogCategory, message: string, jobId?: number | null, meta?: any) =>
    log("error", category, message, jobId, meta),
};

export function getLogFilePath() {
  return LOG_FILE;
}
