import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { backupState, restoreState } from "./state-backup.js";
import { acquireStateOwnership, OWNER_FILE, stateDirectories, type StateDirectories } from "./state-ownership.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-backup-"));
  const dirs = stateDirectories({
    DATA_DIR: path.join(root, "data"),
    CONFIG_DIR: path.join(root, "config"),
    MEDIA_DIR: path.join(root, "media"),
    CONVERT_BATCH_DIR: path.join(root, "external-batches"),
  });
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dirs.media, "show"));
  fs.mkdirSync(path.join(dirs.data, "bin"));
  fs.writeFileSync(path.join(dirs.data, "bin/tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const source = path.join(dirs.media, "show/episode.srt");
  const output = path.join(dirs.media, "show/episode.eng.srt");
  fs.writeFileSync(source, "original media subtitle");
  fs.writeFileSync(`${output}.part`, "translated subtitle");
  fs.writeFileSync(
    `${output}.part.json`,
    JSON.stringify({ workKey: "saved-work", cues: { 1: "translated subtitle" }, connections: ["local"] }),
  );
  fs.writeFileSync(
    path.join(dirs.config, "config.json"),
    JSON.stringify({
      settings: { auto_translate: "0", watch_enabled: "0", youtube_notes_dir: path.join(dirs.media, "notes") },
      tasks: [],
      _next_task_id: 1,
    }),
  );
  fs.writeFileSync(path.join(dirs.data, "queue-run.json"), JSON.stringify({ ids: [99999] }));
  fs.writeFileSync(
    path.join(dirs.data, "transcription-work.json"),
    JSON.stringify({ version: 2, items: [], receipts: [], reviewSelections: { [source]: { size: 1, taskIds: [] } } }),
  );
  fs.writeFileSync(
    path.join(dirs.data, "transcription-history.json"),
    JSON.stringify([{ id: "attempt", status: "running", inputPath: source, outputPath: output }]),
  );
  fs.writeFileSync(path.join(dirs.batches, "saved-batch.json"), JSON.stringify({ resume: "external batch payload" }));
  const db = new Database(path.join(dirs.data, "subsmelt.db"));
  db.pragma("journal_mode = WAL");
  db.exec(
    `CREATE TABLE jobs (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, srt_path TEXT NOT NULL, output_path TEXT NOT NULL, video_path TEXT, status TEXT, priority INTEGER DEFAULT 0, force INTEGER DEFAULT 0, total_cues INTEGER DEFAULT 0, completed_cues INTEGER, error TEXT, duration_seconds REAL, created_at TEXT, updated_at TEXT, output_claim TEXT);`,
  );
  db.prepare(
    "INSERT INTO jobs (id, task_id, srt_path, output_path, video_path, status, completed_cues, output_claim) VALUES (1, 1, ?, ?, NULL, 'translating', 42, ?)",
  ).run(source, output, output);
  return { root, dirs, db, output, source, bundle: path.join(root, "bundle") };
}
function destinations(root: string, media?: string): StateDirectories {
  return stateDirectories({
    DATA_DIR: path.join(root, "restored-data"),
    CONFIG_DIR: path.join(root, "restored-config"),
    MEDIA_DIR: media || path.join(root, "restored-media"),
    CONVERT_BATCH_DIR: path.join(root, "restored-batches"),
  });
}
function environment(dirs: StateDirectories) {
  return {
    ...process.env,
    DATA_DIR: dirs.data,
    CONFIG_DIR: dirs.config,
    MEDIA_DIR: dirs.media,
    CONVERT_BATCH_DIR: dirs.batches,
    PORT: "0",
    HOST: "127.0.0.1",
  };
}
function savedJob(dirs: StateDirectories) {
  const db = new Database(path.join(dirs.data, "subsmelt.db"), { readonly: true });
  try {
    return db.prepare("SELECT * FROM jobs WHERE id=1").get() as Record<string, unknown>;
  } finally {
    db.close();
  }
}

test("backup refuses owned state without resetting the live row or creating a bundle", async () => {
  const f = fixture();
  const ownership = acquireStateOwnership(f.dirs);
  try {
    const before = fs.readFileSync(path.join(f.dirs.config, "config.json"));
    await assert.rejects(backupState(f.dirs, f.bundle), /state is already in use/);
    assert.equal(fs.existsSync(f.bundle), false);
    assert.equal(savedJob(f.dirs).completed_cues, 42);
    assert.equal(savedJob(f.dirs).status, "translating");
    assert.deepEqual(fs.readFileSync(path.join(f.dirs.config, "config.json")), before);
  } finally {
    ownership.release();
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("snapshot includes WAL, JSON, external batches and resume state; restore remaps and startup recovers", async () => {
  const f = fixture();
  let app: ReturnType<typeof spawn> | undefined;
  try {
    assert.ok(fs.statSync(path.join(f.dirs.data, "subsmelt.db-wal")).size > 0);
    const manifest = await backupState(f.dirs, f.bundle);
    assert.ok(manifest.files.some((entry) => entry.scope === "batches" && entry.path === "saved-batch.json"));
    assert.ok(manifest.files.some((entry) => entry.scope === "media" && entry.path.endsWith(".part.json")));
    assert.equal(
      manifest.files.some((entry) => entry.path.includes(OWNER_FILE) || entry.path.endsWith("-wal")),
      false,
    );
    assert.equal(
      manifest.files.some((entry) => entry.path === "show/episode.srt"),
      false,
    );
    const target = destinations(f.root);
    restoreState(f.bundle, target);
    assert.equal(fs.statSync(path.join(target.data, "bin/tool")).mode & 0o777, 0o700);
    assert.equal(savedJob(target).completed_cues, 42);
    assert.equal(savedJob(target).status, "translating");
    assert.equal(savedJob(target).srt_path, path.join(target.media, "show/episode.srt"));
    assert.equal(savedJob(target).output_claim, path.join(target.media, "show/episode.eng.srt"));
    assert.deepEqual(
      fs.readFileSync(path.join(target.media, "show/episode.eng.srt.part.json")),
      fs.readFileSync(`${f.output}.part.json`),
    );
    assert.ok(
      JSON.parse(fs.readFileSync(path.join(target.data, "transcription-work.json"), "utf8")).reviewSelections[
        path.join(target.media, "show/episode.srt")
      ],
    );
    assert.ok(fs.existsSync(path.join(target.data, "queue-run.json")));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target.config, "config.json"), "utf8")).settings.youtube_notes_dir,
      path.join(target.media, "notes"),
    );
    app = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
      env: environment(target),
      stdio: "pipe",
    });
    let logs = "";
    app.stdout!.on("data", (bytes) => {
      logs += bytes;
    });
    app.stderr!.on("data", (bytes) => {
      logs += bytes;
    });
    const deadline = Date.now() + 15000;
    while (!logs.includes("SubSmelt started")) {
      if (app.exitCode !== null || Date.now() > deadline) throw new Error(logs || "Startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(savedJob(target).status, "pending");
    assert.equal(savedJob(target).completed_cues, 0);
    const recoveryDeadline = Date.now() + 10000;
    const historyFile = path.join(target.data, "transcription-history.json");
    while (JSON.parse(fs.readFileSync(historyFile, "utf8"))[0].status !== "failed") {
      if (app.exitCode !== null || Date.now() > recoveryDeadline) {
        throw new Error(`Transcription recovery was not persisted\n${logs}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(fs.existsSync(path.join(target.media, "show/episode.eng.srt.part.json")));
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      const closed = once(app, "close");
      app.kill("SIGKILL");
      await closed;
    }
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("restore supports an existing media library and refuses progress conflicts before writing state", async () => {
  const f = fixture();
  try {
    await backupState(f.dirs, f.bundle);
    const target = destinations(f.root, f.dirs.media);
    assert.throws(() => restoreState(f.bundle, target), /would overwrite an existing file/);
    assert.equal(fs.existsSync(path.join(target.data, "subsmelt.db")), false);
    assert.equal(fs.readFileSync(f.source, "utf8"), "original media subtitle");
    fs.unlinkSync(`${f.output}.part`);
    fs.unlinkSync(`${f.output}.part.json`);
    restoreState(f.bundle, target);
    assert.equal(savedJob(target).srt_path, f.source);
    assert.equal(fs.readFileSync(f.source, "utf8"), "original media subtitle");
    assert.equal(fs.readFileSync(`${f.output}.part`, "utf8"), "translated subtitle");
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("normal entry point refuses both shared data and shared config before imports mutate state", () => {
  const f = fixture();
  const owner = acquireStateOwnership(f.dirs);
  try {
    const before = fs.readFileSync(path.join(f.dirs.config, "config.json"));
    fs.symlinkSync(f.dirs.data, path.join(f.root, "alias-data"));
    fs.symlinkSync(f.dirs.config, path.join(f.root, "alias-config"));
    for (const target of [
      { ...f.dirs, data: path.join(f.root, "alias-data"), config: path.join(f.root, "other-config") },
      {
        ...f.dirs,
        data: path.join(f.root, "other-data"),
        config: path.join(f.root, "alias-config"),
        batches: path.join(f.root, "other-batches"),
      },
    ]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
        env: { ...environment(target), PORT: "19999" },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /state is already in use/);
      assert.equal(savedJob(f.dirs).status, "translating");
      assert.equal(savedJob(f.dirs).completed_cues, 42);
      assert.deepEqual(fs.readFileSync(path.join(f.dirs.config, "config.json")), before);
      if (target.data !== path.join(f.root, "alias-data"))
        assert.equal(fs.existsSync(path.join(target.data, "subsmelt.db")), false);
      if (target.config !== path.join(f.root, "alias-config"))
        assert.equal(fs.existsSync(path.join(target.config, "config.json")), false);
    }
  } finally {
    owner.release();
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("importing db alone no longer performs interrupted-job recovery", () => {
  const f = fixture();
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "const { default: db } = await import('./src/server/db.ts'); db.close();",
      ],
      { env: environment(f.dirs), encoding: "utf8", timeout: 10000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(savedJob(f.dirs).status, "translating");
    assert.equal(savedJob(f.dirs).completed_cues, 42);
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("malformed, tampered, traversal, symlink and orphan-progress bundles are rejected", async (t) => {
  for (const attack of [
    "version",
    "mode",
    "checksum",
    "traversal",
    "absolute",
    "duplicate",
    "missing",
    "symlink",
    "orphan",
    "corrupt-db",
  ]) {
    await t.test(attack, async () => {
      const f = fixture();
      try {
        await backupState(f.dirs, f.bundle);
        const file = path.join(f.bundle, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        const media = manifest.files.find((entry: any) => entry.scope === "media");
        if (attack === "version") manifest.version = 99;
        if (attack === "mode") manifest.files[0].mode = 0o777;
        if (attack === "checksum") manifest.files[0].sha256 = "0".repeat(64);
        if (attack === "traversal") media.path = "../../escaped.part";
        if (attack === "absolute") media.path = "/tmp/escaped.part";
        if (attack === "duplicate") manifest.files.push(manifest.files[0]);
        if (attack === "missing") manifest.files = manifest.files.filter((entry: any) => entry.path !== "config.json");
        if (attack === "symlink") {
          const original = path.join(f.bundle, "media", media.path);
          fs.unlinkSync(original);
          fs.symlinkSync(f.source, original);
        }
        if (attack === "orphan") {
          fs.renameSync(path.join(f.bundle, "media", media.path), path.join(f.bundle, "media/unrelated.part"));
          media.path = "unrelated.part";
        }
        if (attack === "corrupt-db") {
          const value = Buffer.from("not a database");
          fs.writeFileSync(path.join(f.bundle, "data/subsmelt.db"), value);
          const entry = manifest.files.find((entry: any) => entry.path === "subsmelt.db");
          entry.size = value.length;
          entry.sha256 = createHash("sha256").update(value).digest("hex");
        }
        fs.writeFileSync(file, JSON.stringify(manifest));
        const target = destinations(f.root);
        assert.throws(() => restoreState(f.bundle, target));
        assert.equal(fs.existsSync(target.data), false);
        assert.equal(fs.readFileSync(f.source, "utf8"), "original media subtitle");
      } finally {
        f.db.close();
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    });
  }
});

test("restore refuses a symlink within the media destination and nonempty state", async () => {
  const f = fixture();
  try {
    await backupState(f.dirs, f.bundle);
    const target = destinations(f.root);
    fs.mkdirSync(target.media);
    fs.symlinkSync(path.join(f.dirs.media, "show"), path.join(target.media, "show"));
    assert.throws(() => restoreState(f.bundle, target), /Unsafe state file/);
    assert.equal(fs.existsSync(path.join(target.data, "subsmelt.db")), false);
    fs.writeFileSync(path.join(target.data, "keep.txt"), "existing work");
    assert.throws(() => restoreState(f.bundle, target), /must be empty/);
    assert.equal(fs.readFileSync(path.join(target.data, "keep.txt"), "utf8"), "existing work");
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("restore rolls back a partial media write and can retry the same destinations", async (t) => {
  const f = fixture();
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeSync;
  let failingDescriptor = -1;
  try {
    await backupState(f.dirs, f.bundle);
    const target = destinations(f.root);
    fs.mkdirSync(target.media);
    fs.writeFileSync(path.join(target.media, "keep.srt"), "existing media");
    const failingPath = path.join(fs.realpathSync(target.media), "show/episode.eng.srt.part.json");
    const open = t.mock.method(fs, "openSync", (...args: Parameters<typeof originalOpen>) => {
      const [file, flags] = args;
      const descriptor = originalOpen(...args);
      if (file === failingPath && typeof flags === "number" && flags & fs.constants.O_EXCL) {
        failingDescriptor = descriptor;
      }
      return descriptor;
    });
    const write = t.mock.method(fs, "writeSync", ((
      descriptor: number,
      bytes: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position?: number | null,
    ) => {
      if (descriptor === failingDescriptor) {
        originalWrite(descriptor, bytes, offset, 1, position);
        throw Object.assign(new Error("Injected partial-write failure"), { code: "ENOSPC" });
      }
      return originalWrite(descriptor, bytes, offset, length, position);
    }) as typeof fs.writeSync);
    assert.throws(() => restoreState(f.bundle, target), /Injected partial-write failure/);
    open.mock.restore();
    write.mock.restore();
    assert.equal(fs.existsSync(path.join(target.data, "subsmelt.db")), false);
    assert.equal(fs.existsSync(path.join(target.config, "config.json")), false);
    assert.equal(fs.existsSync(path.join(target.batches, "saved-batch.json")), false);
    assert.equal(fs.existsSync(path.join(target.media, "show")), false);
    assert.equal(fs.readFileSync(path.join(target.media, "keep.srt"), "utf8"), "existing media");
    restoreState(f.bundle, target);
    assert.equal(savedJob(target).completed_cues, 42);
    assert.equal(fs.readFileSync(path.join(target.media, "show/episode.eng.srt.part"), "utf8"), "translated subtitle");
  } finally {
    t.mock.restoreAll();
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("restore preserves late media conflicts and replacements while rolling back its own files", async (t) => {
  const f = fixture();
  const originalOpen = fs.openSync;
  try {
    await backupState(f.dirs, f.bundle);
    const target = destinations(f.root);
    const conflict = path.join(target.media, "show/episode.eng.srt.part.json");
    const open = t.mock.method(fs, "openSync", (...args: Parameters<typeof originalOpen>) => {
      const [file, flags] = args;
      if (
        String(file).endsWith("/restored-media/show/episode.eng.srt.part.json") &&
        typeof flags === "number" &&
        flags & fs.constants.O_EXCL
      ) {
        const previous = String(file).slice(0, -".json".length);
        fs.renameSync(previous, `${previous}.moved`);
        fs.writeFileSync(previous, "concurrent replacement");
        fs.writeFileSync(file, "concurrent progress");
      }
      return originalOpen(...args);
    });
    assert.throws(() => restoreState(f.bundle, target), /EEXIST/);
    open.mock.restore();
    assert.equal(fs.readFileSync(conflict, "utf8"), "concurrent progress");
    const previous = path.join(target.media, "show/episode.eng.srt.part");
    assert.equal(fs.readFileSync(previous, "utf8"), "concurrent replacement");
    assert.equal(fs.readFileSync(`${previous}.moved`, "utf8"), "translated subtitle");
    assert.equal(fs.existsSync(path.join(target.data, "subsmelt.db")), false);
    fs.unlinkSync(conflict);
    fs.unlinkSync(previous);
    restoreState(f.bundle, target);
    assert.equal(savedJob(target).completed_cues, 42);
  } finally {
    t.mock.restoreAll();
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("restore rejects ancestor-file collisions between nested data and batches before copying", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.dirs.data, "convert-batches"));
    fs.writeFileSync(path.join(f.dirs.data, "convert-batches/collision"), "data file");
    fs.mkdirSync(path.join(f.dirs.batches, "collision"));
    fs.writeFileSync(path.join(f.dirs.batches, "collision/batch.json"), "{}");
    await backupState(f.dirs, f.bundle);
    const target = destinations(f.root);
    target.batches = path.join(target.data, "convert-batches");
    assert.throws(() => restoreState(f.bundle, target), /overlapping restore destinations/);
    assert.equal(fs.existsSync(path.join(target.data, "subsmelt.db")), false);
    assert.equal(fs.existsSync(path.join(target.config, "config.json")), false);
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("restore remaps the local transcription prefix and preserves the remote prefix and media alias", async () => {
  const f = fixture();
  try {
    const configFile = path.join(f.dirs.config, "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.settings.transcription_path_map_from = f.dirs.media;
    config.settings.transcription_path_map_to = f.dirs.media;
    fs.writeFileSync(configFile, JSON.stringify(config));
    await backupState(f.dirs, f.bundle);
    const target = destinations(f.root);
    const library = path.join(f.root, "existing-library");
    fs.mkdirSync(library);
    fs.symlinkSync(library, target.media);
    restoreState(f.bundle, target);
    const settings = JSON.parse(fs.readFileSync(path.join(target.config, "config.json"), "utf8")).settings;
    assert.equal(settings.transcription_path_map_from, target.media);
    assert.equal(settings.transcription_path_map_to, f.dirs.media);
    assert.equal(savedJob(target).srt_path, path.join(target.media, "show/episode.srt"));
    assert.equal(fs.readFileSync(path.join(library, "show/episode.eng.srt.part"), "utf8"), "translated subtitle");
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
