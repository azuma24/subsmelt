import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

// config.ts reads CONFIG_DIR and the override variables at import, so set them first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-env-connections-"));
const configFile = path.join(root, "config", "config.json");
process.env.CONFIG_DIR = path.dirname(configFile);
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
for (const name of ["LLM_ENDPOINT", "API_KEY", "MODEL", "WHISPER_BACKEND_URL", "WHISPER_BACKEND_TOKEN", "WHISPER_TRANSPORT"]) {
  delete process.env[name];
}
process.env.LLM_ENDPOINT = "http://env-llm:1/v1";
process.env.API_KEY = "sk-from-env";
fs.mkdirSync(path.dirname(configFile));
fs.writeFileSync(configFile, JSON.stringify({ settings: {} }));

const { registerSettingsTasksRoutes } = await import("./routes/settings-tasks.js");

const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test("saving the whole settings form does not copy env-set connection values into config.json", async () => {
  const current = await (await fetch(`${base}/api/settings`)).json();
  const body = Object.fromEntries(Object.entries(current).filter(([key, value]) => !key.startsWith("_") && typeof value === "string"));
  body.model = "ui-model";

  const result = await (
    await fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  ).json();

  assert.equal(result.ok, true);
  const saved = JSON.parse(fs.readFileSync(configFile, "utf8")).settings;
  assert.equal(saved.model, "ui-model");
  assert.equal(saved.llm_connections ?? "", "");
  assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /sk-from-env/);
});
