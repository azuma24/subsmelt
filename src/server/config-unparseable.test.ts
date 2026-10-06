import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

// config.ts loads config.json at import, so plant the broken file first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-config-"));
const configDir = path.join(root, "config");
const configFile = path.join(configDir, "config.json");
const brokenBytes = '{"settings":{"model":"keep-me"},"tasks":[{"id":7,';
fs.mkdirSync(configDir);
fs.writeFileSync(configFile, brokenBytes);
process.env.CONFIG_DIR = configDir;
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
const config = await import("./config.js");
const { getLogs } = await import("./db.js");
const { registerSettingsTasksRoutes } = await import("./routes/settings-tasks.js");

const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const backups = () => fs.readdirSync(configDir).filter((name) => name.startsWith("config.json.broken-"));

test("an unparseable config.json is backed up, logged, and reported to the UI", async () => {
  assert.equal(backups().length, 1);
  assert.equal(fs.readFileSync(path.join(configDir, backups()[0]), "utf8"), brokenBytes);

  const failure = (await (await fetch(`${base}/api/settings`)).json())._config_load_error;
  assert.equal(failure.file, configFile);
  assert.equal(failure.backup, path.join(configDir, backups()[0]));
  assert.ok(failure.message.length > 0);
  assert.ok(getLogs({ level: "error" }).some((row) => row.message.includes(backups()[0])));
});

test("a broken config is never silently replaced: background saves and settings edits leave it alone", async () => {
  config.setSetting("media_scanned", "1");
  config.createTask({ source_lang: "Automatic", target_lang: "French", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "fr" });
  const res = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "typed-in-ui" }),
  });

  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /could not be read/);
  assert.equal(fs.readFileSync(configFile, "utf8"), brokenBytes);
});

test("the file is replaced only when the user confirms it, after which saves work again", async () => {
  const res = await fetch(`${base}/api/settings/replace-broken-config`, { method: "POST" });
  assert.deepEqual(await res.json(), { ok: true });

  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).settings.media_scanned, "1");
  assert.equal((await (await fetch(`${base}/api/settings`)).json())._config_load_error, null);
  config.setSetting("model", "saved-after-recovery");
  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).settings.model, "saved-after-recovery");
  assert.equal(backups().length, 1, "the backup stays for the user to recover from");
});
