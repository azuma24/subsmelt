import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// config.ts, db.ts and logger.ts read these at import, so point them at a scratch folder first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-llm-status-"));
process.env.CONFIG_DIR = path.join(scratch, "config");
process.env.DATA_DIR = path.join(scratch, "data");
process.env.MEDIA_DIR = path.join(scratch, "media");

const { default: express } = await import("express");
const { setSettings } = await import("./config.js");
const { buildLlmStatus, createReachabilityProbe } = await import("./llm-status.js");
const { registerLlmStatusRoutes } = await import("./routes/llm-status.js");
type ResolvedConnection = import("./connections.js").ResolvedConnection;

/** A fake OpenAI-compatible host that answers /models and counts the hits. */
async function startLlmHost(status = 200) {
  const hits: { url?: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m1" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, hits };
}

/** A port nothing listens on: connections to it are refused at once. */
async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return `http://127.0.0.1:${port}/v1`;
}

const local = (id: string, apiHost: string, extra: Partial<ResolvedConnection> = {}): ResolvedConnection => ({
  id,
  label: id.toUpperCase(),
  apiKey: "",
  apiHost,
  model: `${id}-model`,
  ...extra,
});

// Runs first, while the scratch config is still the untouched default.
test("an install with no LLM set up reports no connections", async () => {
  const app = express();
  registerLlmStatusRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/llm/status`);
  assert.deepEqual(await res.json(), { mode: "single", connections: [] });
});

test("states come from the queue first, then from the probe", async () => {
  const up = await startLlmHost();
  const down = await closedPortUrl();
  const status = await buildLlmStatus({
    mode: "fallback",
    pool: [
      local("busy", down),
      local("flagged", up.url),
      local("idle", up.url),
      local("gone", down),
      { ...local("cloud", ""), provider: "openai", apiKey: "sk-cloud" },
    ],
    activeJobs: [
      { jobId: 12, id: "busy", label: "busy", host: down, model: "m" },
      { jobId: 13, id: "busy", label: "busy", host: down, model: "m" },
      // Removed from Settings while job 14 still runs on it.
      { jobId: 14, id: "elsewhere", label: "Old box", host: "http://user:secret@10.0.0.9:1234/v1", model: "old-model" },
    ],
    offlineIds: ["flagged"],
    // The cloud connection is asked at its provider, answered here.
    probe: createReachabilityProbe({
      fetchImpl: (input, init) =>
        String(input).startsWith("https://api.openai.com/") ? Promise.resolve(new Response("{}")) : fetch(input, init),
    }),
  });

  assert.equal(status.mode, "fallback");
  assert.deepEqual(
    status.connections.map((c) => [c.id, c.state, c.jobIds]),
    [
      ["busy", "in_use", [12, 13]],
      ["flagged", "offline", []],
      ["idle", "idle", []],
      ["gone", "offline", []],
      ["cloud", "idle", []],
      ["elsewhere", "in_use", [14]],
    ],
  );
  assert.deepEqual(
    { label: status.connections[5].label, model: status.connections[5].model, host: status.connections[5].host },
    { label: "Old box", model: "old-model", host: "10.0.0.9:1234" },
  );
  assert.equal(status.connections[4].host, "api.openai.com");
  assert.equal(status.connections[2].host, new URL(up.url).host);
  // The queue already knows the busy and flagged hosts; only the idle one is asked.
  assert.equal(up.hits.length, 1);
});

test("the probe sends the connection's key and caches the answer", async () => {
  const host = await startLlmHost();
  let clock = 1_000;
  const probe = createReachabilityProbe({ now: () => clock, ttlMs: 60_000 });
  const conn = local("lan", host.url, { apiKey: "sk-lan" });

  assert.equal(await probe(conn), "reachable");
  assert.equal(await probe(conn), "reachable");
  assert.deepEqual(host.hits, [{ url: "/v1/models", auth: "Bearer sk-lan" }]);

  clock += 60_001;
  assert.equal(await probe(conn), "reachable");
  assert.equal(host.hits.length, 2);
});

test("an HTTP error, a refused port, and a stalled host all read as offline", async () => {
  const unauthorized = await startLlmHost(401);
  const refused = await closedPortUrl();
  const stalled = http.createServer(() => {
    /* never answers */
  });
  stalled.listen(0, "127.0.0.1");
  await once(stalled, "listening");
  after(() => {
    stalled.closeAllConnections();
    stalled.close();
  });
  const stalledUrl = `http://127.0.0.1:${(stalled.address() as AddressInfo).port}/v1`;

  const probe = createReachabilityProbe({ timeoutMs: 200 });
  assert.equal(await probe(local("a", unauthorized.url)), "offline");
  assert.equal(await probe(local("b", refused)), "offline");
  assert.equal(await probe(local("c", stalledUrl)), "offline");
  assert.equal(await probe(local("d", "not a url")), "unknown");
});

test("cloud connections are asked at their provider's models endpoint with their own auth", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const answers: Record<string, () => Promise<Response>> = {
    "sk-good": () => Promise.resolve(new Response("{}", { status: 200 })),
    "sk-expired": () => Promise.resolve(new Response("{}", { status: 401 })),
    "sk-no-access": () => Promise.resolve(new Response("{}", { status: 403 })),
    "sk-unreachable": () => Promise.reject(new TypeError("fetch failed")),
  };
  const probe = createReachabilityProbe({
    fetchImpl: (input, init) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, headers });
      const key =
        headers.authorization?.replace("Bearer ", "") ??
        headers["x-api-key"] ??
        new URL(url).searchParams.get("key") ??
        "";
      return answers[key]();
    },
  });
  const cloud = (provider: "openai" | "anthropic" | "gemini", apiKey: string) =>
    local(`${provider}-${apiKey}`, "", { provider, apiKey });

  assert.equal(await probe(cloud("openai", "sk-good")), "reachable");
  assert.equal(await probe(cloud("anthropic", "sk-expired")), "offline");
  assert.equal(await probe(cloud("gemini", "sk-no-access")), "offline");
  assert.equal(await probe(cloud("openai", "sk-unreachable")), "offline");
  assert.equal(await probe(cloud("openai", "")), "offline", "a cloud connection without a key cannot work");
  assert.equal(await probe(cloud("openai", "sk-good")), "reachable");

  assert.deepEqual(
    calls.map((c) => new URL(c.url).origin + new URL(c.url).pathname),
    [
      "https://api.openai.com/v1/models",
      "https://api.anthropic.com/v1/models",
      "https://generativelanguage.googleapis.com/v1beta/models",
      "https://api.openai.com/v1/models",
    ],
  );
  assert.equal(calls[0].headers.authorization, "Bearer sk-good");
  assert.equal(calls[1].headers["x-api-key"], "sk-expired");
  assert.equal(calls[1].headers["anthropic-version"], "2023-06-01");
});

test("GET /api/llm/status lists the pool in order and never returns a key", async () => {
  const up = await startLlmHost();
  const down = await closedPortUrl();
  setSettings({
    llm_mode: "fallback",
    llm_connections: JSON.stringify([
      {
        id: "backup",
        label: "Spare box",
        provider: "local",
        apiKey: "sk-backup-secret",
        model: "gemma",
        endpoint: down,
        order: 1,
      },
      {
        id: "desk",
        label: "Desk GPU",
        provider: "local",
        apiKey: "sk-desk-secret",
        model: "qwen",
        endpoint: up.url,
        order: 0,
      },
      { id: "off", label: "Disabled", provider: "local", model: "x", endpoint: up.url, order: 2, enabled: false },
    ]),
  });
  const app = express();
  registerLlmStatusRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/llm/status`);
  const raw = await res.text();

  assert.equal(res.status, 200);
  assert.ok(!raw.includes("sk-"), "the response carries no API key");
  assert.deepEqual(JSON.parse(raw), {
    mode: "fallback",
    connections: [
      { id: "desk", label: "Desk GPU", model: "qwen", host: new URL(up.url).host, state: "idle", jobIds: [] },
      { id: "backup", label: "Spare box", model: "gemma", host: new URL(down).host, state: "offline", jobIds: [] },
    ],
  });
});
