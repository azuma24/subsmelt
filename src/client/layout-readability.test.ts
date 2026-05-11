import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/client/index.css", "utf8");
const app = readFileSync("src/client/App.tsx", "utf8");
const shell = readFileSync("src/client/app/shell.tsx", "utf8");
const primitives = readFileSync("src/client/ui/primitives.tsx", "utf8");
const dashboard = readFileSync("src/client/features/dashboard/DashboardPage.tsx", "utf8");

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

test("desktop sidebar auto-compacts at small desktop widths", () => {
  assert.match(shell, /w-20 lg:w-52/);
  assert.match(shell, /hidden min-w-0 lg:block/);
  assert.match(shell, /hidden flex-1 lg:inline/);
});

test("shared controls avoid tiny helper text and preserve touch-friendly targets", () => {
  assert.doesNotMatch(primitives, /text-\[10px\]/);
  assert.match(primitives, /min-h-\[44px\]/);
  assert.match(primitives, /leading-6/);
});

test("dashboard hero uses intentional desktop action grouping", () => {
  assert.match(dashboard, /aria-label=\{t\("dashboard\.hero\.scanActions"\)\}/);
  assert.match(dashboard, /xl:flex-row/);
  assert.match(dashboard, /sm:grid-cols-2/);
  assert.match(dashboard, /xl:w-\[34rem\]/);
  assert.match(dashboard, /sm:col-span-2/);
});

test("dashboard keeps small desktop layouts readable before switching to mobile", () => {
  assert.match(dashboard, /text-balance text-2xl/);
  assert.match(dashboard, /text-pretty text-sm/);
  assert.match(dashboard, /sm:grid-cols-2 xl:grid-cols-4/);
  assert.match(dashboard, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)_auto\]/);
});
