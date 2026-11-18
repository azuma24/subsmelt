import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireStateOwnership, OWNER_FILE, type StateDirectories } from "./state-ownership.js";

const SCOPES = ["data", "config", "batches", "media"] as const;
type Scope = (typeof SCOPES)[number];
interface BundleFile {
  scope: Scope;
  path: string;
  size: number;
  sha256: string;
  mode: 0o600 | 0o700;
}
export interface BackupManifest {
  format: "subsmelt-state";
  version: 1;
  createdAt: string;
  roots: StateDirectories;
  files: BundleFile[];
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function relativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(OWNER_FILE))
  );
}

/** Reject links at every component below an explicitly selected root. */
function safeFile(root: string, relative: string): string {
  if (!relativePath(relative)) throw new Error(`Unsafe bundle path: ${relative}`);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Unsafe state file: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

function canonicalDestination(input: string): string {
  const absolute = path.resolve(input);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A dangling link must not be mistaken for a directory we may create.
    try {
      fs.lstatSync(absolute);
      throw new Error(`Dangling destination link: ${absolute}`);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
    return path.join(canonicalDestination(path.dirname(absolute)), path.basename(absolute));
  }
}

function digest(file: string): { size: number; sha256: string } {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let size = 0;
  try {
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = fs.readSync(fd, bytes, 0, bytes.length, null);
      if (count === 0) break;
      size += count;
      hash.update(bytes.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size, sha256: hash.digest("hex") };
}

function walk(root: string, visit: (relative: string, file: string) => void, skip = new Set<string>()): void {
  function descend(relative: string) {
    const dir = relative ? safeFile(root, relative) : root;
    for (const entry of fs.readdirSync(dir).sort()) {
      if (entry.startsWith(OWNER_FILE)) continue;
      const rel = relative ? `${relative}/${entry}` : entry;
      const file = safeFile(root, rel);
      if (skip.has(file)) continue;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) descend(rel);
      else if (stat.isFile()) visit(rel, file);
      else throw new Error(`Unsupported state file: ${file}`);
    }
  }
  if (fs.existsSync(root)) descend("");
}

function verifyDatabase(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("SQLite integrity check failed");
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("SQLite foreign key check failed");
    db.prepare("SELECT id, task_id, srt_path, output_path, video_path, status, completed_cues FROM jobs LIMIT 1").all();
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' LIMIT 1").get()) {
      throw new Error("Unexpected database triggers in backup");
    }
  } finally {
    db.close();
  }
}

function verifyConfig(file: string): void {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !config ||
    typeof config !== "object" ||
    !config.settings ||
    typeof config.settings !== "object" ||
    Array.isArray(config.settings) ||
    !Object.values(config.settings).every((value) => typeof value === "string") ||
    !Array.isArray(config.tasks) ||
    !Number.isSafeInteger(config._next_task_id)
  ) {
    throw new Error("Invalid config.json in backup");
  }
}

function assertEmpty(root: string, allowedDirectory?: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith(OWNER_FILE)) continue;
    const file = path.join(root, entry);
    if (allowedDirectory && inside(file, allowedDirectory) && fs.lstatSync(file).isDirectory()) {
      assertEmpty(file, allowedDirectory);
    } else {
      throw new Error(`Restore destination must be empty: ${root}`);
    }
  }
}

export async function backupState(directories: StateDirectories, destination: string): Promise<BackupManifest> {
  const output = canonicalDestination(destination);
  if (fs.existsSync(output)) throw new Error(`Backup destination already exists: ${output}`);
  const ownership = acquireStateOwnership(directories);
  let created = false;
  try {
    const roots = ownership.directories;
    for (const selectedRoot of Object.values(roots)) {
      const root = canonicalDestination(selectedRoot);
      if (inside(root, output) || inside(output, root))
        throw new Error("Backup destination must be outside state roots");
    }
    const database = safeFile(roots.data, "subsmelt.db");
    verifyDatabase(database);
    verifyConfig(safeFile(roots.config, "config.json"));
    fs.mkdirSync(output, { recursive: false, mode: 0o700 });
    created = true;
    for (const scope of SCOPES) fs.mkdirSync(path.join(output, scope), { mode: 0o700 });
    const snapshot = path.join(output, "data/subsmelt.db");
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
      await db.backup(snapshot);
    } finally {
      db.close();
    }
    const packed = new Database(snapshot);
    try {
      packed.pragma("journal_mode = DELETE");
    } finally {
      packed.close();
    }
    fs.chmodSync(snapshot, 0o600);
    const manifest: BackupManifest = {
      format: "subsmelt-state",
      version: 1,
      createdAt: new Date().toISOString(),
      roots,
      files: [{ scope: "data", path: "subsmelt.db", mode: 0o600, ...digest(snapshot) }],
    };
    function copy(scope: Scope, relative: string, source: string) {
      const target = safeFile(path.join(output, scope), relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      const mode = fs.statSync(source).mode & 0o100 ? 0o700 : 0o600;
      fs.chmodSync(target, mode);
      manifest.files.push({ scope, path: relative, mode, ...digest(target) });
    }
    for (const scope of ["data", "config", "batches"] as const) {
      const skip = new Set<string>();
      if (scope === "data") {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) skip.add(path.join(roots.data, `subsmelt.db${suffix}`));
      }
      for (const other of ["config", "batches"] as const) {
        if (roots[other] !== roots[scope] && inside(roots[scope], roots[other])) skip.add(roots[other]);
      }
      walk(roots[scope], (relative, file) => copy(scope, relative, file), skip);
    }
    const saved = new Database(snapshot, { readonly: true });
    try {
      const outputs = saved.prepare("SELECT DISTINCT output_path FROM jobs").all() as Array<{ output_path: string }>;
      for (const { output_path: outputPath } of outputs) {
        for (const suffix of [".part", ".part.json"]) {
          const source = path.resolve(`${outputPath}${suffix}`);
          if (!fs.existsSync(source)) continue;
          if (!inside(roots.media, source)) throw new Error(`Job resume file is outside MEDIA_DIR: ${source}`);
          const relative = path.relative(roots.media, source).split(path.sep).join("/");
          copy("media", relative, safeFile(roots.media, relative));
        }
      }
    } finally {
      saved.close();
    }
    verifyDatabase(snapshot);
    fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } catch (error) {
    if (created) fs.rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    ownership.release();
  }
}

function readManifest(bundle: string): BackupManifest {
  const raw = JSON.parse(fs.readFileSync(safeFile(bundle, "manifest.json"), "utf8"));
  if (
    raw?.format !== "subsmelt-state" ||
    raw.version !== 1 ||
    typeof raw.createdAt !== "string" ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    !Array.isArray(raw.files) ||
    !raw.roots
  ) {
    throw new Error("Unsupported or malformed backup manifest");
  }
  for (const scope of SCOPES) {
    const root = raw.roots[scope];
    if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0") || path.normalize(root) !== root) {
      throw new Error(`Invalid ${scope} root in manifest`);
    }
  }
  const found = new Set<string>();
  for (const entry of raw.files) {
    if (
      !entry ||
      !SCOPES.includes(entry.scope) ||
      !relativePath(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      (entry.mode !== 0o600 && entry.mode !== 0o700) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Malformed backup file entry");
    }
    const relative = `${entry.scope}/${entry.path}`;
    if (found.has(relative)) throw new Error(`Duplicate backup file: ${relative}`);
    found.add(relative);
    const actual = digest(safeFile(bundle, relative));
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256)
      throw new Error(`Backup checksum mismatch: ${relative}`);
    if (entry.scope === "media" && !/\.part(?:\.json)?$/.test(entry.path)) {
      throw new Error("Backup media payload may contain only translation resume files");
    }
  }
  if (!found.has("data/subsmelt.db") || !found.has("config/config.json"))
    throw new Error("Backup is missing required state");
  walk(bundle, (relative) => {
    if (relative !== "manifest.json" && !found.has(relative)) throw new Error(`Unlisted backup file: ${relative}`);
  });
  verifyDatabase(safeFile(bundle, "data/subsmelt.db"));
  verifyConfig(safeFile(bundle, "config/config.json"));
  const database = new Database(safeFile(bundle, "data/subsmelt.db"), { readonly: true });
  try {
    const paths = database.prepare("SELECT output_path FROM jobs").all() as Array<{ output_path: string }>;
    const expected = new Set(
      paths.flatMap(({ output_path: output }) => {
        if (!path.isAbsolute(output) || !inside(raw.roots.media, output)) return [];
        const relative = path.relative(raw.roots.media, output).split(path.sep).join("/");
        return [`${relative}.part`, `${relative}.part.json`];
      }),
    );
    for (const entry of raw.files) {
      if (entry.scope === "media" && !expected.has(entry.path))
        throw new Error("Resume file has no matching database job");
    }
  } finally {
    database.close();
  }
  return raw as BackupManifest;
}

function remapper(source: StateDirectories, target: StateDirectories): (value: string) => string {
  const mappings = SCOPES.map((scope) => [source[scope], target[scope]] as const).sort(
    (a, b) => b[0].length - a[0].length,
  );
  return (value) => {
    if (!path.isAbsolute(value)) return value;
    const match = mappings.find(([root]) => inside(root, value));
    return match ? path.join(match[1], path.relative(match[0], value)) : value;
  };
}

function remapState(stage: string, source: StateDirectories, target: StateDirectories): void {
  const remap = remapper(source, target);
  const isPath = (key: string) =>
    /(?:path|dir|_from|_to)$/i.test(key) || ["input", "output_claim", "srt_name"].includes(key);
  function remapJson(value: unknown, key = ""): unknown {
    if (typeof value === "string") return isPath(key) ? remap(value) : value;
    if (Array.isArray(value)) return value.map((item) => remapJson(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([name, child]) => [remap(name), remapJson(child, name)]));
    }
    return value;
  }
  for (const relative of [
    "config/config.json",
    "data/transcription-history.json",
    "data/transcription-no-speech.json",
    "data/transcription-work.json",
  ]) {
    const file = safeFile(stage, relative);
    if (!fs.existsSync(file)) continue;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify(remapJson(value)), { mode: 0o600 });
  }
  const db = new Database(path.join(stage, "data/subsmelt.db"));
  try {
    db.pragma("journal_mode = DELETE");
    const tables = {
      jobs: ["srt_path", "output_path", "video_path", "output_claim"],
      youtube_videos: ["media_path", "subtitle_path", "note_path"],
      llm_usage: ["srt_name"],
    };
    db.transaction(() => {
      for (const [table, candidates] of Object.entries(tables)) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.length) continue;
        for (const column of candidates.filter((name) => columns.some((entry) => entry.name === name))) {
          const rows = db
            .prepare(`SELECT rowid AS _rowid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
            .all() as Array<{ _rowid: number; value: string }>;
          const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
          for (const row of rows) {
            const mapped = remap(row.value);
            if (mapped !== row.value) update.run(mapped, row._rowid);
          }
        }
      }
    })();
  } finally {
    db.close();
  }
}

export function restoreState(bundlePath: string, destinations: StateDirectories): BackupManifest {
  const bundle = fs.realpathSync(bundlePath);
  const manifest = readManifest(bundle);
  const canonical = Object.fromEntries(
    SCOPES.map((scope) => [scope, canonicalDestination(destinations[scope])]),
  ) as unknown as StateDirectories;
  const target = { ...canonical, media: path.resolve(destinations.media) };
  for (const scope of SCOPES) {
    if (inside(bundle, canonical[scope]) || inside(canonical[scope], bundle))
      throw new Error("Restore destinations must be outside the bundle");
    for (const other of SCOPES) {
      if (scope === other || (scope === "data" && other === "batches")) continue;
      if (inside(canonical[scope], canonical[other]))
        throw new Error("Restore roots must be separate, except batches inside data");
    }
  }
  assertEmpty(target.data, target.batches);
  assertEmpty(target.config);
  assertEmpty(target.batches);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-restore-"));
  try {
    for (const entry of manifest.files) {
      const relative = `${entry.scope}/${entry.path}`;
      const to = safeFile(stage, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(safeFile(bundle, relative), to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, entry.mode);
      const actual = digest(to);
      if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
        throw new Error("Backup changed during restore");
    }
    remapState(stage, manifest.roots, target);
    verifyDatabase(path.join(stage, "data/subsmelt.db"));
    verifyConfig(path.join(stage, "config/config.json"));
    const ownership = acquireStateOwnership(target);
    try {
      assertEmpty(target.data, target.batches);
      assertEmpty(target.config);
      assertEmpty(target.batches);
      const files = manifest.files.map((entry) => ({
        source: safeFile(stage, `${entry.scope}/${entry.path}`),
        mode: entry.mode,
        destination: safeFile(target[entry.scope], entry.path),
      }));
      if (new Set(files.map((file) => file.destination)).size !== files.length) {
        throw new Error("Backup files have overlapping restore destinations");
      }
      for (const file of files) {
        try {
          fs.lstatSync(file.destination);
          throw new Error(`Restore would overwrite an existing file: ${file.destination}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      // Each copy also refuses a file created after the conflict preflight.
      for (const file of files) {
        fs.mkdirSync(path.dirname(file.destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(file.source, file.destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(file.destination, file.mode);
      }
      verifyDatabase(path.join(target.data, "subsmelt.db"));
      verifyConfig(path.join(target.config, "config.json"));
    } finally {
      ownership.release();
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return manifest;
}
