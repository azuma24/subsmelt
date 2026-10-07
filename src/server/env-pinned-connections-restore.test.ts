import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

// An install that saved its own local connection, later run with all three LLM env variables.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-env-restore-"));
const configFile = path.join(root, "config", "config.json");
process.env.CONFIG_DIR = path.dirname(configFile);
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
for (const name of [
  "LLM_ENDPOINT",
  "API_KEY",
  "MODEL",
  "WHISPER_BACKEND_URL",
  "WHISPER_BACKEND_TOKEN",
  "WHISPER_TRANSPORT",
]) {
  delete process.env[name];
}
process.env.LLM_ENDPOINT = "http://env-llm:1/v1";
process.env.API_KEY = "sk-from-env";
process.env.MODEL = "env-model";
const savedLocal = {
  id: "local",
  label: "Desk",
  provider: "local",
  apiKey: "sk-saved",
  model: "saved-model",
  endpoint: "http://saved:1/v1",
  enabled: true,
  order: 0,
};
fs.mkdirSync(path.dirname(configFile));
fs.writeFileSync(configFile, JSON.stringify({ settings: { llm_connections: JSON.stringify([savedLocal]) } }));

const { getAllSettings } = await import("./config.js");
const { registerSettingsTasksRoutes } = await import("./routes/settings-tasks.js");

const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test("editing connections under env pins keeps the saved local connection, so removing the env restores it", async () => {
  const current = await (await fetch(`${base}/api/settings`)).json();
  const connections = JSON.parse(current.llm_connections);
  assert.deepEqual([connections[0].endpoint, connections[0].model], ["http://env-llm:1/v1", "env-model"]);
  connections[0].label = "Desk GPU";
  connections.push({
    id: "openai",
    label: "OpenAI",
    provider: "openai",
    apiKey: "sk-cloud",
    model: "gpt-4o",
    endpoint: "",
    enabled: true,
    order: 1,
  });

  const result = await (
    await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ llm_connections: JSON.stringify(connections) }),
    })
  ).json();
  assert.deepEqual(result, { ok: true, rejected: [] });

  const saved = JSON.parse(JSON.parse(fs.readFileSync(configFile, "utf8")).settings.llm_connections);
  assert.deepEqual(saved[0], { ...savedLocal, label: "Desk GPU" });
  assert.equal(saved[1].apiKey, "sk-cloud");
  const effective = JSON.parse(getAllSettings().llm_connections);
  assert.deepEqual(
    [effective[0].endpoint, effective[0].apiKey, effective[0].model],
    ["http://env-llm:1/v1", "sk-from-env", "env-model"],
  );
});
