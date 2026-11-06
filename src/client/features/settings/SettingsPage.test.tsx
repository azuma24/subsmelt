import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, TEST_APP_VERSION, type QuerySeed } from "../../test-render";
import { SettingsPage } from "./SettingsPage";

const freshInstall: QuerySeed = [
  [["settings"], {}],
  [["tasks"], []],
  [["jobs"], { jobs: [], queueRunning: false, currentJobId: null }],
];

test("Settings opens on the LLM connection section with every section in the nav", () => {
  const page = renderPage(<SettingsPage />, freshInstall);

  assert.match(page.text, /^Settings Save /);
  for (const section of [
    "LLM Connection",
    "Translation Engine",
    "Sources & Monitoring",
    "Speech-to-text",
    "Interface",
  ]) {
    assert.ok(page.buttons.includes(section), `missing section ${section}`);
  }
  assert.ok(page.headings.includes("LLM Connection"));
  assert.ok(page.buttons.includes("+ Add connection"));
  assert.ok(page.text.includes(`SubSmelt v${TEST_APP_VERSION}`));
});

test("Save stays disabled until something is edited", () => {
  const page = renderPage(<SettingsPage />, freshInstall);

  assert.match(page.html, /<button\b[^>]*\bdisabled=""[^>]*>Save<\/button>/);
});

test("a fresh install lists what is left to set up", () => {
  const page = renderPage(<SettingsPage />, freshInstall);

  assert.ok(page.text.includes("Setup checklist 0 of 3 done"));
  assert.ok(page.text.includes("○ LLM connection Configure endpoint and model."));
  assert.ok(page.buttons.includes("Open Translations"));
});

test("speech-to-text settings links directly to processing profiles on desktop and mobile", () => {
  for (const isMobile of [false, true]) {
    const page = renderPage(<SettingsPage />, freshInstall, { path: "/settings?section=stt", isMobile });
    assert.ok(page.links.includes("Processing profiles"));
    assert.match(page.html, /href="#processing-profiles"/);
    assert.match(page.html, /id="processing-profiles" tabindex="-1"/);
  }
});

test("Sources shows a polling-only watcher as active and offers to pause it", () => {
  const page = renderPage(
    <SettingsPage />,
    [
      ...freshInstall,
      [["watcher-status"], { enabled: true, running: true, fileEvents: "off", pollIntervalMinutes: 30 }],
    ],
    { path: "/settings?section=sources" },
  );
  assert.ok(page.text.includes("Watcher active · Polling every 30 min"));
  assert.ok(page.buttons.includes("Pause monitoring"));
});
