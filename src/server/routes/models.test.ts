import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts and logger.ts create and load their folders at import, so point
// them at a scratch folder first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-models-"));
process.env.CONFIG_DIR = path.join(scratch, "config");
process.env.DATA_DIR = path.join(scratch, "data");
const { setSettings } = await import("../config.js");
const { listModels } = await import("./models.js");

function recordFetches(t: TestContext): { url: string; headers: unknown }[] {
  const calls: { url: string; headers: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers });
    return Response.json({ data: [{ id: "m1" }] });
  });
  return calls;
}

test("the saved api_key goes only to the saved llm_endpoint, never to a caller-supplied one", async (t) => {
  setSettings({ api_key: "sk-secret-123", llm_endpoint: "http://lm:1234/v1", llm_connections: "" });
  const calls = recordFetches(t);

  await listModels("local", "", "http://attacker.example/v1");
  await listModels("local", "", "http://lm:1234/v1/");
  await listModels("local", "", "");

  assert.deepEqual(calls, [
    { url: "http://attacker.example/v1/models", headers: {} },
    { url: "http://lm:1234/v1/models", headers: { Authorization: "Bearer sk-secret-123" } },
    { url: "http://lm:1234/v1/models", headers: { Authorization: "Bearer sk-secret-123" } },
  ]);
});

test("Fetch models on a saved connection uses its saved key, only at its own destination", async (t) => {
  setSettings({
    api_key: "",
    cloud_api_key_openai: "",
    llm_connections: JSON.stringify([
      { id: "c1", provider: "openai", apiKey: "sk-c1", model: "gpt-4o", endpoint: "http://localhost:8000/v1" },
      { id: "c2", provider: "local", apiKey: "sk-c2", model: "m1", endpoint: "http://lan:8080/v1" },
    ]),
  });
  const calls = recordFetches(t);

  await listModels("openai", "", "", "c1");
  await listModels("local", "", "http://lan:8080/v1", "c2");
  await listModels("local", "", "http://attacker.example/v1", "c2");

  assert.deepEqual(calls, [
    { url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer sk-c1" } },
    { url: "http://lan:8080/v1/models", headers: { Authorization: "Bearer sk-c2" } },
    { url: "http://attacker.example/v1/models", headers: {} },
  ]);
});
