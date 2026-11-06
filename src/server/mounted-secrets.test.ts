import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-mounted-secrets-"));
const configDir = path.join(root, "config");
const configFile = path.join(configDir, "config.json");
const llmFile = path.join(root, "llm-secret");
const whisperFile = path.join(root, "whisper-secret");
const storedLocal = {
  id: "local",
  label: "Desk",
  provider: "local",
  apiKey: "saved-local-key",
  model: "local-model",
  endpoint: "http://saved:8000/v1",
  enabled: true,
  order: 0,
};
fs.mkdirSync(configDir);
fs.writeFileSync(llmFile, " mounted-local-key \r\n");
fs.writeFileSync(whisperFile, "mounted-whisper-token\n");
fs.writeFileSync(
  configFile,
  JSON.stringify({
    settings: {
      api_key: "saved-legacy-key",
      transcription_backend_token: "saved-whisper-token",
      llm_connections: JSON.stringify([storedLocal]),
    },
  }),
);
Object.assign(process.env, {
  CONFIG_DIR: configDir,
  DATA_DIR: path.join(root, "data"),
  MEDIA_DIR: path.join(root, "media"),
  API_KEY_FILE: llmFile,
  WHISPER_BACKEND_TOKEN_FILE: whisperFile,
});
delete process.env.API_KEY;
delete process.env.WHISPER_BACKEND_TOKEN;

const config = await import("./config.js");
const { REDACTED_SECRET } = await import("./connections.js");
const { default: db } = await import("./db.js");
const { registerSettingsTasksRoutes } = await import("./routes/settings-tasks.js");
const app = express();
app.use(express.json());
registerSettingsTasksRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(async () => {
  const closed = once(server, "close");
  server.close();
  await closed;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test("mounted secrets pin their settings and stay out of persisted connections", async () => {
  assert.equal(config.getSetting("api_key"), "mounted-local-key");
  assert.equal(config.getSetting("transcription_backend_token"), "mounted-whisper-token");
  assert.equal(JSON.parse(config.getAllSettings().llm_connections)[0].apiKey, "mounted-local-key");

  const settings = await (await fetch(`${base}/api/settings`)).json();
  assert.ok(settings._env_pinned.includes("api_key"));
  assert.ok(settings._env_pinned.includes("transcription_backend_token"));
  assert.equal(settings.api_key, REDACTED_SECRET);
  assert.equal(settings.transcription_backend_token, REDACTED_SECRET);
  const connections = JSON.parse(settings.llm_connections);
  assert.equal(connections[0].apiKey, REDACTED_SECRET);
  connections[0].label = "Desk GPU";

  const response = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: REDACTED_SECRET,
      transcription_backend_token: "ui-edit",
      llm_connections: JSON.stringify(connections),
    }),
  });
  assert.deepEqual(await response.json(), { ok: true, rejected: ["transcription_backend_token"] });
  const stored = JSON.parse(fs.readFileSync(configFile, "utf8")).settings;
  assert.equal(stored.api_key, "saved-legacy-key");
  assert.equal(stored.transcription_backend_token, "saved-whisper-token");
  assert.deepEqual(JSON.parse(stored.llm_connections)[0], { ...storedLocal, label: "Desk GPU" });
});

test("direct env keeps precedence and file aliases are explicit", () => {
  assert.deepEqual(
    config.envSettingOverrides({
      API_KEY: " from-env ",
      API_KEY_FILE: "missing-path",
      WHISPER_BACKEND_TOKEN: "",
      WHISPER_BACKEND_TOKEN_FILE: whisperFile,
      MODEL_FILE: "missing-path",
    }),
    { api_key: " from-env ", transcription_backend_token: "mounted-whisper-token" },
  );
});

test("invalid selected secret files fail without exposing their paths or bytes", () => {
  const invalid = path.join(root, "invalid-private-path");
  fs.writeFileSync(invalid, "private-first-line\nprivate-second-line");
  for (const file of [invalid, path.join(root, "missing-private-path"), root]) {
    assert.throws(() => config.envSettingOverrides({ API_KEY_FILE: file }), {
      message: "API_KEY_FILE must point to a readable file containing one nonempty UTF-8 credential",
    });
  }
});
