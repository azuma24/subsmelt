import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-log-redaction-"));
const mountedKey = "local-credential/+";
const configuredToken = "whisper-private-token";
const connectionKey = "stored-cloud-key";
const webhook = "https://example.test/hooks/private-path?access_token=private-query";
const secretFile = path.join(root, "llm-secret");
fs.writeFileSync(secretFile, mountedKey + "\n");
Object.assign(process.env, {
  CONFIG_DIR: path.join(root, "config"),
  DATA_DIR: path.join(root, "data"),
  API_KEY_FILE: secretFile,
  WHISPER_BACKEND_TOKEN: configuredToken,
});
delete process.env.API_KEY;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { getLogFilePath, logger, setLogDb } = await import("./logger.js");
const config = await import("./config.js");
config.setSettings({
  llm_connections: JSON.stringify([{ apiKey: connectionKey }]),
  notify_webhook_url: webhook,
});

test("redacts once before console, JSON file, and queued database writes", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const db = new Database(":memory:");
  db.exec("CREATE TABLE logs (timestamp TEXT, level TEXT, category TEXT, message TEXT, job_id INTEGER, meta TEXT)");
  const metadata = {
    headers: { Authorization: "Bearer transient-auth", "x-api-key": "transient-api-key" },
    payload: [{ model: "whisper", apiKey: "transient-connection-key", detail: connectionKey }],
    prompt_tokens: 17,
    unrelated_key: "preserve this",
  };

  logger.warn(
    "system",
    `Credentials ${mountedKey} ${encodeURIComponent(mountedKey)} ${configuredToken} ${webhook}. Authorization: Basic dXNlcjpwYXNz`,
    23,
    metadata,
  );
  setLogDb(db);
  const saved = db.prepare("SELECT * FROM logs").get() as { message: string; job_id: number; meta: string };
  const file = JSON.parse(fs.readFileSync(getLogFilePath(), "utf8").trim());
  const consoleOutput = String(warn.mock.calls[0]?.arguments[0]);
  const { local_time: localTime, ...fileMeta } = file.meta;
  assert.equal(typeof localTime, "string");
  assert.deepEqual(fileMeta, JSON.parse(saved.meta));
  assert.deepEqual(fileMeta, {
    headers: { Authorization: "[redacted]", "x-api-key": "[redacted]" },
    payload: [{ model: "whisper", apiKey: "[redacted]", detail: "[redacted]" }],
    prompt_tokens: 17,
    unrelated_key: "preserve this",
  });
  assert.equal(saved.job_id, 23);
  assert.equal(file.message, saved.message);
  assert.match(consoleOutput, /\[WARN\] \[system\] Credentials/);
  assert.ok(consoleOutput.endsWith(saved.message));
  for (const secret of [
    mountedKey,
    encodeURIComponent(mountedKey),
    configuredToken,
    connectionKey,
    "private-path",
    "private-query",
    "dXNlcjpwYXNz",
    "transient-auth",
  ]) {
    assert.ok(![consoleOutput, JSON.stringify(file), JSON.stringify(saved)].some((output) => output.includes(secret)));
  }
  assert.equal(metadata.headers.Authorization, "Bearer transient-auth");
  db.close();
});

test("a saved credential change refreshes redaction and keeps unrelated fields", (t) => {
  const info = t.mock.method(console, "log", () => {});
  config.setSettings({ youtube_api_key: "updated-youtube-credential", cloud_api_key_openai: "x" });
  logger.info("system", "updated-youtube-credential x extra X-ray count=5 https://example.test/?page=ok");
  const output = String(info.mock.calls[0]?.arguments[0]);
  assert.ok(output.endsWith("[redacted] [redacted] extra X-ray count=5 https://example.test/?page=ok"));
});
