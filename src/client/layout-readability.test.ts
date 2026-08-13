import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/client/index.css", "utf8");
const app = readFileSync("src/client/App.tsx", "utf8");
const shell = readFileSync("src/client/app/shell.tsx", "utf8");
const primitives = readFileSync("src/client/ui/primitives.tsx", "utf8");
const dashboard = [
  "src/client/features/dashboard/DashboardPage.tsx",
  "src/client/features/dashboard/DashboardHero.tsx",
  "src/client/features/dashboard/QueueToolbar.tsx",
  "src/client/features/dashboard/ScanConfirmModal.tsx",
  "src/client/features/dashboard/TranscriptionHistoryPanel.tsx",
].map((path) => readFileSync(path, "utf8")).join("\n");

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

test("dashboard hero metric band stays a responsive hairline grid", () => {
  // Cockpit Grid band: status filters + tokens in one row on desktop, wrapping
  // to 2-3 rows on narrow screens (gap-px over a border bg draws the dividers).
  assert.match(dashboard, /grid-cols-2 gap-px[^"]*sm:grid-cols-3 lg:grid-cols-6/);
  assert.match(dashboard, /font-mono text-\[20px\] font-semibold tabular-nums/);
});

test("dashboard keeps small desktop layouts readable before switching to mobile", () => {
  assert.match(dashboard, /text-balance text-2xl/);
  assert.match(dashboard, /text-pretty text-sm/);
  assert.match(dashboard, /sm:grid-cols-2 xl:grid-cols-4/);
  assert.match(dashboard, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)_auto\]/);
});
