import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import { LLM_STATUS_QUERY_KEY } from "../../hooks";
import { ConvertPage } from "./ConvertPage";

test("an empty Convert page asks for files and holds the Translate action", () => {
  const page = renderPage(<ConvertPage />, [[["settings"], {}]]);

  assert.deepEqual(page.headings, ["Convert / Translate", "Output settings"]);
  assert.ok(page.text.includes("Drag & drop subtitle files here or click to browse"));
  assert.ok(page.text.includes("Add subtitle files above to start."));
  assert.match(page.html, /<button\b[^>]*\bdisabled=""[^>]*>Translate<\/button>/);
});

test("Translate mode offers From and To language pickers", () => {
  const page = renderPage(<ConvertPage />, [[["settings"], {}]]);

  assert.ok(page.text.includes("From language Auto-detect English Japanese"));
  assert.ok(page.text.includes("To language"));
  assert.ok(page.text.includes("Target format SRT VTT ASS SSA"));
});

const GRACE = { id: "grace", label: "Grace", model: "GLM-5.3", host: "grace.test:8000", state: "idle", jobIds: [] };

test("a configured LLM connection does not raise the set-up warning", () => {
  const page = renderPage(<ConvertPage />, [
    [["settings"], {}],
    [LLM_STATUS_QUERY_KEY, { mode: "single", connections: [GRACE] }],
  ]);

  assert.ok(!page.text.includes("Set up an LLM connection in Settings first."));
});

test("no LLM connection raises the set-up warning", () => {
  const page = renderPage(<ConvertPage />, [
    [["settings"], {}],
    [LLM_STATUS_QUERY_KEY, { mode: "single", connections: [] }],
  ]);

  assert.ok(page.text.includes("Set up an LLM connection in Settings first."));
});
