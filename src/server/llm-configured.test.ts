import test from "node:test";
import assert from "node:assert/strict";
import { computeLlmConfigured } from "./llm-configured.js";

// Mirrors the LLM-relevant slice of DEFAULT_SETTINGS.
const DEFAULTS: Record<string, string> = {
  llm_endpoint: "http://localhost:8000/v1",
  api_key: "",
  model: "Qwen/Qwen2.5-72B-Instruct",
  cloud_api_key_openai: "",
  cloud_api_key_anthropic: "",
  cloud_api_key_gemini: "",
  llm_connections: "",
};

// What migrateConnectionsFromFlat(DEFAULT_SETTINGS) produces on a fresh install.
const SEED_CONNS = [
  {
    id: "local",
    label: "Local",
    provider: "local",
    apiKey: "",
    model: "Qwen/Qwen2.5-72B-Instruct",
    endpoint: "http://localhost:8000/v1",
    enabled: true,
    order: 0,
  },
];

const conns = (arr: unknown[]) => JSON.stringify(arr);
const check = (stored: Record<string, string>) =>
  computeLlmConfigured(stored, DEFAULTS, SEED_CONNS);

test("a fresh install is not configured", () => {
  // The whole point: nothing stored, yet the merged view would show a local
  // endpoint and a placeholder model.
  assert.equal(check({}), false);
});

test("stored values identical to the defaults are not configured", () => {
  assert.equal(check({ ...DEFAULTS }), false);
});

test("a saved connection with a model is configured", () => {
  const stored = { llm_connections: conns([{ id: "a", model: "llama3", enabled: true }]) };
  assert.equal(check(stored), true);
});

test("a connection without a model is not configured", () => {
  const stored = { llm_connections: conns([{ id: "a", model: "", enabled: true }]) };
  assert.equal(check(stored), false);
});

test("a disabled connection does not count, even with a model", () => {
  const stored = { llm_connections: conns([{ id: "a", model: "llama3", enabled: false }]) };
  assert.equal(check(stored), false);
});

test("enabled defaults to true when the flag is absent", () => {
  const stored = { llm_connections: conns([{ id: "a", model: "llama3" }]) };
  assert.equal(check(stored), true);
});

test("one usable connection among unusable ones is enough", () => {
  const stored = {
    llm_connections: conns([
      { id: "a", model: "", enabled: true },
      { id: "b", model: "gpt-4o", enabled: false },
      { id: "c", model: "llama3", enabled: true },
    ]),
  };
  assert.equal(check(stored), true);
});

test("malformed llm_connections falls through instead of reporting configured", () => {
  assert.equal(check({ llm_connections: "{not json" }), false);
  assert.equal(check({ llm_connections: "{}" }), false);
  assert.equal(check({ llm_connections: "[]" }), false);
});

test("malformed connections still honour a touched flat key", () => {
  const stored = { llm_connections: "{not json", model: "my-local-model" };
  assert.equal(check(stored), true);
});

test("changing a legacy flat key away from its default counts", () => {
  assert.equal(check({ model: "my-model" }), true);
  assert.equal(check({ llm_endpoint: "http://gpu.lan:1234/v1" }), true);
});

test("setting any cloud API key counts", () => {
  assert.equal(check({ cloud_api_key_openai: "sk-x" }), true);
  assert.equal(check({ cloud_api_key_anthropic: "sk-y" }), true);
  assert.equal(check({ cloud_api_key_gemini: "sk-z" }), true);
});

test("an unrelated stored setting does not imply an LLM is configured", () => {
  assert.equal(check({ auto_translate: "0", chunk_size: "40" }), false);
});

// ── Review finding 1: mere persistence is not a signal ──────────────────────
// The Settings page POSTs the whole settings object it last read, so editing
// any unrelated field writes the synthesized connection back to disk.

test("the synthesized seed connection written back verbatim is not configured", () => {
  assert.equal(check({ llm_connections: conns(SEED_CONNS) }), false);
});

test("an unrelated edit that round-trips the seed connection stays unconfigured", () => {
  // Exactly the reproduction: change chunk_size, POST everything back.
  const stored = { ...DEFAULTS, chunk_size: "40", llm_connections: conns(SEED_CONNS) };
  assert.equal(check(stored), false);
});

test("editing the seed connection's model or endpoint does count", () => {
  assert.equal(
    check({ llm_connections: conns([{ ...SEED_CONNS[0], model: "llama3" }]) }),
    true,
  );
  assert.equal(
    check({ llm_connections: conns([{ ...SEED_CONNS[0], endpoint: "http://gpu.lan:1234/v1" }]) }),
    true,
  );
});

test("a real connection alongside the untouched seed still counts", () => {
  const stored = {
    llm_connections: conns([...SEED_CONNS, { id: "b", provider: "local", model: "llama3" }]),
  };
  assert.equal(check(stored), true);
});

// ── Review finding 2: cloud connections need credentials ────────────────────
// Mirrors isUsable() in connections.ts, so the checklist can't say "done" while
// the queue finds nothing usable.

test("a cloud connection without an API key is not configured", () => {
  for (const provider of ["openai", "anthropic", "gemini"]) {
    const stored = { llm_connections: conns([{ id: "c", provider, model: "gpt-4o", apiKey: "" }]) };
    assert.equal(check(stored), false, `${provider} without a key should not count`);
  }
});

test("a cloud connection with an API key is configured", () => {
  for (const provider of ["openai", "anthropic", "gemini"]) {
    const stored = {
      llm_connections: conns([{ id: "c", provider, model: "gpt-4o", apiKey: "sk-x" }]),
    };
    assert.equal(check(stored), true, `${provider} with a key should count`);
  }
});

test("a local connection needs no API key", () => {
  const stored = { llm_connections: conns([{ id: "a", provider: "local", model: "llama3", apiKey: "" }]) };
  assert.equal(check(stored), true);
});
