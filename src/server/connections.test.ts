import test from "node:test";
import assert from "node:assert/strict";
import { REDACTED_SECRET, parseConnections, resolveRequestApiKey, restoreRedactedApiKeys } from "./connections.js";

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

  assert.deepEqual(JSON.parse(restoreRedactedApiKeys(posted, stored)), [{ ...LEGACY_LOCAL, apiKey: "sk-secret-123" }]);
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

// A legacy flat-key install: GET /api/settings shows these two connections,
// synthesized from api_key/llm_endpoint and cloud_api_key_openai.
const LEGACY_CONNECTIONS = parseConnections({
  api_key: "sk-local",
  llm_endpoint: "http://lm:1234/v1",
  model: "qwen3",
  cloud_api_key_openai: "sk-openai",
  cloud_model_openai: "gpt-4o",
  llm_connections: "",
});

test("a request about a saved connection gets its key when provider and endpoint match", () => {
  const local = { connectionId: "local", provider: "local", endpoint: "http://lm:1234/v1" };

  assert.equal(resolveRequestApiKey(local, LEGACY_CONNECTIONS), "sk-local");
  assert.equal(resolveRequestApiKey({ ...local, apiKey: REDACTED_SECRET }, LEGACY_CONNECTIONS), "sk-local");
  assert.equal(resolveRequestApiKey({ ...local, endpoint: "http://lm:1234/v1/" }, LEGACY_CONNECTIONS), "sk-local");
});

test("a saved local key is not lent to a different endpoint", () => {
  const request = { connectionId: "local", provider: "local", apiKey: REDACTED_SECRET };

  assert.equal(
    resolveRequestApiKey({ ...request, endpoint: "http://attacker.example/v1" }, LEGACY_CONNECTIONS),
    undefined,
  );
  assert.equal(resolveRequestApiKey({ ...request, endpoint: "http://lm:1234/v1" }, LEGACY_CONNECTIONS), "sk-local");
});

test("a saved key is not lent to a different provider", () => {
  const request = { connectionId: "openai", endpoint: "" };

  assert.equal(resolveRequestApiKey({ ...request, provider: "local" }, LEGACY_CONNECTIONS), undefined);
  assert.equal(resolveRequestApiKey({ ...request, provider: "anthropic" }, LEGACY_CONNECTIONS), undefined);
  assert.equal(resolveRequestApiKey({ ...request, provider: "openai" }, LEGACY_CONNECTIONS), "sk-openai");
});

test("an unknown connectionId gets no key", () => {
  const request = { provider: "openai", endpoint: "" };

  assert.equal(resolveRequestApiKey({ ...request, connectionId: "nope" }, LEGACY_CONNECTIONS), undefined);
  assert.equal(resolveRequestApiKey(request, LEGACY_CONNECTIONS), undefined);
  assert.equal(resolveRequestApiKey({ ...request, connectionId: "openai" }, LEGACY_CONNECTIONS), "sk-openai");
});

test("a key typed into the request wins over the saved one", () => {
  const request = { connectionId: "local", provider: "local", endpoint: "http://lm:1234/v1" };

  assert.equal(resolveRequestApiKey({ ...request, apiKey: "sk-typed" }, LEGACY_CONNECTIONS), "sk-typed");
  assert.equal(resolveRequestApiKey(request, LEGACY_CONNECTIONS), "sk-local");
});

test("a saved cloud key is lent whatever endpoint the request carries, since the provider fixes the host", () => {
  // A card switched from local to a cloud provider keeps its old endpoint.
  const saved = parseConnections({
    llm_connections: JSON.stringify([
      { id: "c1", provider: "openai", apiKey: "sk-c1", model: "gpt-4o", endpoint: "http://localhost:8000/v1" },
    ]),
  });

  assert.equal(resolveRequestApiKey({ connectionId: "c1", provider: "openai", endpoint: "" }, saved), "sk-c1");
});
