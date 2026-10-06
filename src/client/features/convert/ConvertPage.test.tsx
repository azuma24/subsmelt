import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import { ConvertPage } from "./ConvertPage";

test("an empty Convert page asks for files and holds the Translate action", () => {
  const page = renderPage(<ConvertPage isMobile={false} />, [[["settings"], {}]]);

  assert.deepEqual(page.headings, ["Convert / Translate", "Output settings"]);
  assert.ok(page.text.includes("Drag & drop subtitle files here or click to browse"));
  assert.ok(page.text.includes("Add subtitle files above to start."));
  assert.match(page.html, /<button disabled=""[^>]*>Translate<\/button>/);
});

test("Translate mode offers From and To language pickers", () => {
  const page = renderPage(<ConvertPage isMobile={false} />, [[["settings"], {}]]);

  assert.ok(page.text.includes("From language Auto-detect English Japanese"));
  assert.ok(page.text.includes("To language"));
  assert.ok(page.text.includes("Target format SRT VTT ASS SSA"));
});
