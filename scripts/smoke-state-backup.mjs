import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-cli-smoke-"));
const dirs = ["data", "config", "media", "batches"].map((name) => path.join(root, name));
for (const dir of dirs) fs.mkdirSync(dir);
const [data, config, media, batches] = dirs;
try {
  const seed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const {default:db}=await import('./dist/server/db.js'); await import('./dist/server/config.js'); db.close();",
    ],
    { env: { ...process.env, DATA_DIR: data, CONFIG_DIR: config, MEDIA_DIR: media }, encoding: "utf8" },
  );
  assert.equal(seed.status, 0, seed.stderr);
  const db = new Database(path.join(data, "subsmelt.db"));
  db.prepare(
    "INSERT INTO jobs (task_id,srt_path,output_path,status,completed_cues) VALUES (1,?,?,'translating',42)",
  ).run(path.join(media, "movie.srt"), path.join(media, "movie.eng.srt"));
  db.close();
  fs.writeFileSync(path.join(media, "movie.eng.srt.part.json"), '{"workKey":"a","cues":{"1":"Hello"}}');
  fs.writeFileSync(path.join(batches, "batch.json"), "{}");
  const run = (...args) => spawnSync(process.execPath, ["scripts/state-backup.mjs", ...args], { encoding: "utf8" });
  assert.equal(run("--help").status, 0);
  const output = path.join(root, "bundle");
  let result = run(
    "backup",
    "--output",
    output,
    "--data-dir",
    data,
    "--config-dir",
    config,
    "--media-dir",
    media,
    "--convert-batch-dir",
    batches,
  );
  assert.equal(result.status, 0, result.stderr);
  process.stdout.write(result.stdout);
  const target = path.join(root, "new-data");
  result = run(
    "restore",
    "--input",
    output,
    "--data-dir",
    target,
    "--config-dir",
    path.join(root, "new-config"),
    "--media-dir",
    path.join(root, "new-media"),
  );
  assert.equal(result.status, 0, result.stderr);
  process.stdout.write(result.stdout);
  assert.ok(fs.existsSync(path.join(target, "convert-batches", "batch.json")));
  const recovered = new Database(path.join(target, "subsmelt.db"), { readonly: true });
  assert.equal(recovered.prepare("SELECT completed_cues FROM jobs").get().completed_cues, 42);
  recovered.close();
  result = run("restore", "--input", output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires explicit --data-dir/);
  process.stdout.write("CLI smoke passed, including explicit-destination guard.\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
