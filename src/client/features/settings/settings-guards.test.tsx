import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import { ConfigLoadErrorBanner, configLoadFailureOf } from "./ConfigLoadErrorBanner";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { REDACTED_SECRET } from "./settings-model";

const noop = () => {};

test("an unreadable config.json shows what happened, where the copy is, and how to replace it", () => {
  const failure = configLoadFailureOf({
    _config_load_error: { file: "/config/config.json", backup: "/config/config.json.broken-2026", message: "Unexpected end of JSON input" },
  });
  assert.ok(failure);
  const page = renderPage(<ConfigLoadErrorBanner failure={failure} />);

  assert.match(page.text, /\/config\/config\.json could not be read\./);
  assert.match(page.text, /A copy is at \/config\/config\.json\.broken-2026\./);
  assert.match(page.text, /Unexpected end of JSON input/);
  assert.ok(page.buttons.includes("Replace config file"));
  assert.equal(configLoadFailureOf({ _config_load_error: null }), null);
});

test("connection fields an environment variable sets are read-only and say which variable", () => {
  const settings = {
    _env_pinned: ["llm_endpoint", "api_key"],
    llm_connections: JSON.stringify([
      { id: "local", label: "Local", provider: "local", apiKey: REDACTED_SECRET, model: "qwen", endpoint: "http://env-llm:1/v1", enabled: true, order: 0 },
    ]),
  };
  const page = renderPage(<ConnectionsPanel settings={settings} update={noop} addToast={noop} isMobile={false} />);

  assert.match(page.html, /<input[^>]*readonly=""[^>]*value="http:\/\/env-llm:1\/v1"/);
  assert.match(page.text, /Set by the LLM_ENDPOINT environment variable\. Change it there\./);
  assert.match(page.text, /Set by the API_KEY environment variable\./);
  assert.doesNotMatch(page.text, /MODEL environment variable/);
});
