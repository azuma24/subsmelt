import test from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTION_TIMEOUT_LIMIT,
  OFFLINE_ATTEMPTS,
  connectionModelsUrl,
  createConnectionHealth,
  isTransportFailure,
} from "./connection-health.js";
import type { ResolvedConnection } from "../connections.js";

function conn(id: string, overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id,
    label: id,
    apiKey: "",
    apiHost: "http://localhost:1234/v1",
    model: "test-model",
    ...overrides,
  } as ResolvedConnection;
}

const noDelay = async () => {};
const okResponse = () => new Response("{}", { status: 200 });

test("only transport stalls count toward the breaker", () => {
  // Both phrasings occur: ai-client says "timeout", the transcription client
  // says "timed out". Matching only one left the breaker dead for the common case.
  assert.equal(isTransportFailure(new Error("Request timed out after 300s")), true);
  assert.equal(isTransportFailure(new Error("Request timeout after 300000ms")), true);
  assert.equal(isTransportFailure(new Error("network error")), true);
  assert.equal(isTransportFailure(new Error("fetch failed")), true);
  assert.equal(isTransportFailure(new Error("connect ECONNREFUSED 127.0.0.1:8000")), true);
  // The model returning junk is not the endpoint being down.
  assert.equal(isTransportFailure(new Error("did not match schema")), false);
  assert.equal(isTransportFailure(new Error("401 Unauthorized")), false);
});

test("a connection is dropped after the timeout limit and reported once", () => {
  const events: string[] = [];
  const health = createConnectionHealth({
    onConnectionUnavailable: (info) => events.push(info.error),
  });
  const target = conn("flaky");

  for (let i = 0; i < CONNECTION_TIMEOUT_LIMIT - 1; i++) {
    health.noteFailure(target, new Error("timeout"));
    assert.equal(health.isDisabled("flaky"), false, "must not drop before the limit");
  }

  health.noteFailure(target, new Error("timeout"));
  assert.equal(health.isDisabled("flaky"), true);

  // Further failures must not re-announce it.
  health.noteFailure(target, new Error("timeout"));
  assert.equal(events.length, 1);
  assert.match(events[0], /timeouts in this job/);
});

test("schema failures never drop a connection, however many there are", () => {
  const health = createConnectionHealth();
  const target = conn("picky");
  for (let i = 0; i < 10; i++) health.noteFailure(target, new Error("did not match schema"));
  assert.equal(health.isDisabled("picky"), false);
});

test("live() filters out dropped connections and preserves order", () => {
  const health = createConnectionHealth();
  const a = conn("a");
  const b = conn("b");
  const c = conn("c");
  for (let i = 0; i < CONNECTION_TIMEOUT_LIMIT; i++) health.noteFailure(b, new Error("timeout"));

  assert.deepEqual(health.live([a, b, c]).map((x) => x.id), ["a", "c"]);
});

test("availability is probed once, then cached for the job", async () => {
  let calls = 0;
  const health = createConnectionHealth({
    fetchImpl: async () => { calls += 1; return okResponse(); },
    delayImpl: noDelay,
  });
  const target = conn("probe-once");

  await health.ensureReady(target);
  await health.ensureReady(target);

  assert.equal(calls, 1);
});

test("an unreachable connection is retried, then marked unavailable", async () => {
  const events: string[] = [];
  let calls = 0;
  const health = createConnectionHealth({
    fetchImpl: async () => { calls += 1; throw new Error("ECONNREFUSED"); },
    delayImpl: noDelay,
    onConnectionUnavailable: (info) => events.push(info.error),
  });
  const target = conn("down");

  await assert.rejects(() => health.ensureReady(target), /Connection unavailable after 5 attempts/);
  assert.equal(calls, OFFLINE_ATTEMPTS);
  assert.equal(events.length, 1);

  // A second call fails immediately without probing again.
  await assert.rejects(() => health.ensureReady(target), /marked unavailable/);
  assert.equal(calls, OFFLINE_ATTEMPTS, "must not re-probe a known-dead connection");
});

test("cloud SDK providers skip the probe entirely", async () => {
  let calls = 0;
  const health = createConnectionHealth({ fetchImpl: async () => { calls += 1; return okResponse(); } });

  await health.ensureReady(conn("cloud", { provider: "openai" as ResolvedConnection["provider"] }));

  assert.equal(calls, 0);
  assert.equal(connectionModelsUrl(conn("cloud", { provider: "openai" as ResolvedConnection["provider"] })), null);
});

test("models URL is derived from the API host", () => {
  assert.equal(connectionModelsUrl(conn("a")), "http://localhost:1234/v1/models");
  assert.equal(
    connectionModelsUrl(conn("b", { apiHost: "http://host:8000/v1/" })),
    "http://host:8000/v1/models",
  );
  assert.equal(connectionModelsUrl(conn("c", { apiHost: "not a url" })), null);
});

test("withConnection releases the lock even when the work throws", async () => {
  let released = 0;
  const health = createConnectionHealth({
    fetchImpl: async () => okResponse(),
    delayImpl: noDelay,
    acquireConnection: async () => () => { released += 1; },
  });

  const value = await health.withConnection(conn("ok"), async () => "done");
  assert.equal(value, "done");
  assert.equal(released, 1);

  await assert.rejects(() => health.withConnection(conn("ok"), async () => { throw new Error("boom"); }), /boom/);
  assert.equal(released, 2);
});

test("reserved connections are not re-acquired", async () => {
  let acquired = 0;
  const health = createConnectionHealth({
    fetchImpl: async () => okResponse(),
    reservedConnectionIds: ["mine"],
    acquireConnection: async () => { acquired += 1; return () => {}; },
  });

  await health.withConnection(conn("mine"), async () => null);
  assert.equal(acquired, 0, "the caller already holds this lock");

  await health.withConnection(conn("other"), async () => null);
  assert.equal(acquired, 1);
});

test("an aborted job stops probing immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const health = createConnectionHealth({
    abortSignal: controller.signal,
    fetchImpl: async () => { throw new Error("should not be called"); },
    delayImpl: noDelay,
  });

  await assert.rejects(() => health.ensureReady(conn("stopped")), /STOP_REQUESTED/);
});
