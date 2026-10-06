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
  const body = Object.fromEntries(
    Object.entries(current).filter(([key, value]) => !key.startsWith("_") && typeof value === "string"),
  );
  body.model = "ui-model";

  const result = await (
    await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

  assert.equal(result.ok, true);
  const saved = JSON.parse(fs.readFileSync(configFile, "utf8")).settings;
  assert.equal(saved.model, "ui-model");
  assert.equal(saved.llm_connections ?? "", "");
  assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /sk-from-env/);
});

test("editing the connections keeps the env key out of config.json and env values in charge", async () => {
  const { getAllSettings } = await import("./config.js");
  const current = await (await fetch(`${base}/api/settings`)).json();
  const connections = JSON.parse(current.llm_connections);
  assert.equal(connections[0].id, "local");
  assert.equal(connections[0].apiKey, "__SUBSMELT_SECRET_REDACTED__");
  connections.push({
    id: "openai",
    label: "OpenAI",
    provider: "openai",
    apiKey: "sk-cloud-typed",
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
  const file = fs.readFileSync(configFile, "utf8");
  assert.doesNotMatch(file, /sk-from-env/);
  const saved = JSON.parse(JSON.parse(file).settings.llm_connections);
  assert.deepEqual(
    saved.map((c: { id: string; apiKey: string }) => [c.id, c.apiKey]),
    [
      ["local", ""],
      ["openai", "sk-cloud-typed"],
    ],
  );

  // The running app still uses the env values for the local connection.
  const effective = JSON.parse(getAllSettings().llm_connections);
  assert.deepEqual([effective[0].endpoint, effective[0].apiKey], ["http://env-llm:1/v1", "sk-from-env"]);
});
