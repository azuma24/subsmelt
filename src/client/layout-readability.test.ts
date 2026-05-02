import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/client/index.css", "utf8");
const app = readFileSync("src/client/App.tsx", "utf8");
const shell = readFileSync("src/client/app/shell.tsx", "utf8");
const primitives = readFileSync("src/client/ui/primitives.tsx", "utf8");

test("global typography uses readable app font and line-height defaults", () => {
  assert.match(css, /font-family:\s*ui-sans-serif/);
  assert.match(css, /font-size:\s*16px/);
  assert.match(css, /line-height:\s*1\.5/);
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
});

test("mobile layout uses dynamic viewport height and safe-area bottom padding", () => {
  assert.match(app, /min-h-dvh/);
  assert.match(app, /h-dvh/);
  assert.match(shell, /pb-\[calc\(0\.75rem\+env\(safe-area-inset-bottom\)\)\]/);
});

test("shared controls avoid tiny helper text and preserve touch-friendly targets", () => {
  assert.doesNotMatch(primitives, /text-\[10px\]/);
  assert.match(primitives, /min-h-\[44px\]/);
  assert.match(primitives, /leading-6/);
});
