import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

// config.ts, db.ts and logger.ts read these at import, so point them at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-settings-route-"));
process.env.CONFIG_DIR = path.join(root, "config");
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
const { getSetting, setSetting } = await import("../config.js");
const { registerSettingsTasksRoutes } = await import("./settings-tasks.js");

const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const getSettings = async () => (await fetch(`${base}/api/settings`)).json();
const saveSettings = (body: Record<string, string>) =>
  fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const WEBHOOK = "https://discord.com/api/webhooks/123/secret-token";

test("the webhook URL, which carries its token, is redacted and kept when the marker comes back", async () => {
  setSetting("notify_webhook_url", WEBHOOK);
  const settings = await getSettings();
  assert.equal(settings.notify_webhook_url, "__SUBSMELT_SECRET_REDACTED__");
  assert.doesNotMatch(JSON.stringify(settings), /secret-token/);

  assert.equal((await saveSettings({ ...settings, notify_format: "discord" })).status, 200);
  assert.equal(getSetting("notify_webhook_url"), WEBHOOK);

  await saveSettings({ notify_webhook_url: "https://hooks.slack.com/services/new" });
  assert.equal(getSetting("notify_webhook_url"), "https://hooks.slack.com/services/new");
  await saveSettings({ notify_webhook_url: "" });
  assert.equal(getSetting("notify_webhook_url"), "");
});

test("out-of-range numeric settings are refused with the allowed range, and nothing in the request is saved", async () => {
  const cases: [string, string, RegExp][] = [
    ["chunk_size", "0", /chunk_size must be a whole number from 1 to 500/],
    ["chunk_size", "-5", /chunk_size/],
    ["chunk_size", "2.5", /chunk_size/],
    ["chunk_size", "", /chunk_size/],
    ["request_timeout_s", "0", /request_timeout_s must be a whole number from 10 to 7200/],
    ["parallel_chunks", "9", /parallel_chunks/],
    ["temperature", "3", /temperature must be a number from 0 to 2/],
    ["temperature", "abc", /temperature/],
    ["transcription_max_concurrent", "0", /transcription_max_concurrent/],
    // Readers use parseInt/parseFloat, which read "1e2" as 1 and "0x10" as 0.
    ["request_timeout_s", "1e2", /request_timeout_s/],
    ["chunk_size", "0x10", /chunk_size/],
    ["chunk_size", " 20", /chunk_size/],
    ["chunk_size", "20.0", /chunk_size/],
    ["temperature", "1e-1", /temperature/],
    ["temperature", "Infinity", /temperature/],
  ];
  for (const [key, value, error] of cases) {
    const res = await saveSettings({ [key]: value, model: "should-not-save" });
    assert.equal(res.status, 400, `${key}=${JSON.stringify(value)}`);
    assert.match((await res.json()).error, error);
  }
  assert.notEqual(getSetting("model"), "should-not-save");
  assert.equal(getSetting("chunk_size"), "20");
});

test("in-range numbers save, and an out-of-range value already stored does not block unrelated saves", async () => {
  const res = await saveSettings({ chunk_size: "40", temperature: ".7", request_timeout_s: "600", context_window: "0", transcription_max_line_length: "0" });
  assert.equal(res.status, 200);
  assert.deepEqual(
    ["chunk_size", "temperature", "request_timeout_s", "context_window", "transcription_max_line_length"].map(getSetting),
    ["40", ".7", "600", "0", "0"],
  );

  setSetting("chunk_size", "0");
  assert.equal((await saveSettings({ chunk_size: "0", model: "unrelated-edit" })).status, 200);
  assert.equal(getSetting("model"), "unrelated-edit");
});
