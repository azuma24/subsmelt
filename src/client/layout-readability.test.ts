import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/client/index.css", "utf8");
const app = readFileSync("src/client/App.tsx", "utf8");
const shell = readFileSync("src/client/app/shell.tsx", "utf8");
// The kit is one file per primitive; the checks below hold for all of them.
const primitives = ["Button", "Status", "Field", "Layout", "Accordion", "Drawer", "RowActionsMenu"]
  .map((name) => readFileSync(`src/client/ui/${name}.tsx`, "utf8"))
  .join("\n");
const dashboard = [
  "src/client/features/dashboard/DashboardPage.tsx",
  "src/client/features/dashboard/DashboardHero.tsx",
  "src/client/features/dashboard/QueueToolbar.tsx",
  "src/client/features/library/ScanConfirmModal.tsx",
  "src/client/features/dashboard/TranscriptionHistoryPanel.tsx",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

test("global typography uses readable app font and line-height defaults", () => {
  assert.match(css, /font-family:\s*ui-sans-serif/);
  assert.match(css, /font-size:\s*16px/);
  assert.match(css, /line-height:\s*1\.5/);
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
});

function lightToken(name: string): string {
  const light = css.slice(css.indexOf('html[data-theme="light"]'));
  const match = light.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `light theme defines --${name}`);
  return match[1];
}

function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channel = (raw: number) => {
      const c = raw / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("light-theme muted text keeps WCAG AA contrast on both panel surfaces", () => {
  const muted = lightToken("text-3");
  assert.ok(contrastRatio(muted, lightToken("surface")) >= 4.5, `--text-3 ${muted} on --surface`);
  assert.ok(contrastRatio(muted, lightToken("surface-2")) >= 4.5, `--text-3 ${muted} on --surface-2`);
  assert.ok(
    contrastRatio(muted, "#ffffff") < contrastRatio(lightToken("text-2"), "#ffffff"),
    "--text-3 stays lighter than --text-2",
  );
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
  assert.match(shell, /h-full min-h-0[^"]*overflow-hidden/);
});

test("shared controls avoid tiny helper text and preserve touch-friendly targets", () => {
  assert.doesNotMatch(primitives, /text-\[\d/);
  assert.match(primitives, /min-h-touch/);
  assert.match(primitives, /leading-6/);
});

test("dashboard hero metric band stays a responsive hairline grid", () => {
  // Cockpit Grid band: status filters + tokens in one row on desktop, wrapping
  // to 2-3 rows on narrow screens (gap-px over a border bg draws the dividers).
  assert.match(dashboard, /grid-cols-2 gap-px[^"]*sm:grid-cols-3 lg:grid-cols-6/);
  assert.match(dashboard, /font-mono text-lg font-semibold tabular-nums/);
});

test("dashboard keeps small desktop layouts readable before switching to mobile", () => {
  // Phones rely on the bottom tab bar for the page name, so the topbar title
  // is screen-reader only there and visible from md up.
  assert.match(dashboard, /titleHiddenBelowMd/);
  assert.match(primitives, /sr-only md:not-sr-only/);
  assert.match(dashboard, /sm:grid-cols-2 xl:grid-cols-4/);
  assert.match(dashboard, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)_auto\]/);
});
