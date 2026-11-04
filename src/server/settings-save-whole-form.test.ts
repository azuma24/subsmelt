import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-settings-save-"));
process.env.CONFIG_DIR = path.join(root, "config");
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
fs.mkdirSync(process.env.CONFIG_DIR);
const config = await import("./config.js");
const { registerSettingsTasksRoutes } = await import("./routes/settings-tasks.js");

const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;

const save = async (body: object) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; rejected: string[] };
};

test("saving the whole settings form after a scan reports nothing as refused", async () => {
  config.setSetting("media_scanned", "1");
  const form = (await (await fetch(base)).json()) as Record<string, unknown>;
  assert.equal(form.media_scanned, "1");

  const result = await save({ ...form, chunk_size: "25" });

  assert.deepEqual(result.rejected, []);
  assert.equal(config.getSetting("chunk_size"), "25");
});

test("a client cannot change the server's own media_scanned flag", async () => {
  config.setSetting("media_scanned", "1");
  await save({ media_scanned: "0" });
  assert.equal(config.getSetting("media_scanned"), "1");
});

test("an unknown key is still refused and not stored", async () => {
  const result = await save({ not_a_setting: "x" });
  assert.deepEqual(result.rejected, ["not_a_setting"]);
  assert.equal("not_a_setting" in config.getAllSettings(), false);
});
