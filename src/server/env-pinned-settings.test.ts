import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

// config.ts reads CONFIG_DIR and the override variables at import, so set them first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-env-pinned-"));
const configFile = path.join(root, "config", "config.json");
process.env.CONFIG_DIR = path.dirname(configFile);
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
for (const name of ["LLM_ENDPOINT", "API_KEY", "MODEL", "WHISPER_BACKEND_URL", "WHISPER_BACKEND_TOKEN", "WHISPER_TRANSPORT"]) {
  delete process.env[name];
}
process.env.LLM_ENDPOINT = "http://env-llm:1/v1";
fs.mkdirSync(path.dirname(configFile));
fs.writeFileSync(configFile, JSON.stringify({ settings: { llm_endpoint: "http://saved:1/v1" } }));

const config = await import("./config.js");
const { registerSettingsTasksRoutes } = await import("./routes/settings-tasks.js");

const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const savedEndpoint = () => JSON.parse(fs.readFileSync(configFile, "utf8")).settings.llm_endpoint;
const saveSettings = async (body: Record<string, string>) =>
  (
    await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

test("an env-set value wins over config.json without being written to it", () => {
  assert.equal(config.getSetting("llm_endpoint"), "http://env-llm:1/v1");
  config.setSetting("model", "saved-model");
  assert.equal(savedEndpoint(), "http://saved:1/v1");
});

test("GET /api/settings reports the env value and which keys are env-pinned", async () => {
  const settings = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(settings.llm_endpoint, "http://env-llm:1/v1");
  assert.deepEqual(settings._env_pinned, ["llm_endpoint"]);
});

test("a new value for an env-pinned key is rejected instead of saved behind the env value", async () => {
  assert.deepEqual(await saveSettings({ llm_endpoint: "http://ui-edit:2/v1", model: "ui-model" }), {
    ok: true,
    rejected: ["llm_endpoint"],
  });
  assert.equal(savedEndpoint(), "http://saved:1/v1");
  assert.equal(config.getSetting("llm_endpoint"), "http://env-llm:1/v1");
  assert.equal(config.getSetting("model"), "ui-model");
});

test("sending the env value back unchanged, as the Settings page does on every save, is not a rejection", async () => {
  assert.deepEqual(await saveSettings({ llm_endpoint: "http://env-llm:1/v1" }), { ok: true, rejected: [] });
  assert.equal(savedEndpoint(), "http://saved:1/v1");
});
