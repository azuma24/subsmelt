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

  assert.match(page.html, /<button disabled=""[^>]*>Save<\/button>/);
});

test("a fresh install lists what is left to set up", () => {
  const page = renderPage(<SettingsPage />, freshInstall);

  assert.ok(page.text.includes("Setup checklist 0 of 3 done"));
  assert.ok(page.text.includes("○ LLM connection Configure endpoint and model."));
  assert.ok(page.buttons.includes("Open Translations"));
});
