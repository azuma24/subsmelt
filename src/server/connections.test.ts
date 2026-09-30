import test from "node:test";
import assert from "node:assert/strict";
import { REDACTED_SECRET, parseConnections, restoreRedactedApiKeys } from "./connections.js";

const LEGACY_LOCAL = {
  id: "local",
  label: "Local",
  provider: "local",
  model: "qwen3",
  endpoint: "http://lm:1234/v1",
  enabled: true,
  order: 0,
};

test("a legacy flat-key install keeps its api_key when the redacted connections are posted back", () => {
  // No llm_connections row yet: GET synthesized this connection from api_key.
  const stored = parseConnections({
    api_key: "sk-secret-123",
    llm_endpoint: "http://lm:1234/v1",
    model: "qwen3",
    llm_connections: "",
  });
  const posted = JSON.stringify([{ ...LEGACY_LOCAL, apiKey: REDACTED_SECRET }]);

  assert.deepEqual(JSON.parse(restoreRedactedApiKeys(posted, stored)), [
    { ...LEGACY_LOCAL, apiKey: "sk-secret-123" },
  ]);
});

test("a redacted connection with no stored key is saved with an empty key, never the marker", () => {
  const stored = parseConnections({
    llm_connections: JSON.stringify([
      { id: "a", provider: "openai", apiKey: "sk-a", model: "gpt-4o" },
      { id: "c", provider: "openai", apiKey: REDACTED_SECRET, model: "gpt-4o" },
    ]),
  });
  const posted = JSON.stringify([
    { id: "a", apiKey: REDACTED_SECRET },
    { id: "b", apiKey: REDACTED_SECRET },
    { id: "c", apiKey: REDACTED_SECRET },
  ]);

  assert.deepEqual(JSON.parse(restoreRedactedApiKeys(posted, stored)), [
    { id: "a", apiKey: "sk-a" },
    { id: "b", apiKey: "" },
    { id: "c", apiKey: "" },
  ]);
});

test("a key typed into the form replaces the stored one", () => {
  const stored = parseConnections({
    llm_connections: JSON.stringify([{ id: "a", provider: "openai", apiKey: "sk-old", model: "gpt-4o" }]),
  });
  const posted = JSON.stringify([{ id: "a", apiKey: "sk-new" }]);

  assert.deepEqual(JSON.parse(restoreRedactedApiKeys(posted, stored)), [{ id: "a", apiKey: "sk-new" }]);
});
