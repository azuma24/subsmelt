import test from "node:test";
import assert from "node:assert/strict";
import { Route, Routes } from "react-router-dom";
import { renderPage, TEST_APP_VERSION, type QuerySeed } from "../../test-render";
import { SettingsPage } from "./SettingsPage";
import { SettingsLayout } from "./SettingsLayout";

const freshInstall: QuerySeed = [
  [["settings"], {}],
  [["tasks"], []],
  [["jobs"], { jobs: [], queueRunning: false, currentJobId: null }],
];

const settingsRoutes = (
  <Routes>
    <Route path="/settings" element={<SettingsLayout />}>
      <Route index element={<SettingsPage />} />
      <Route path="languages" element={<h1>Languages</h1>} />
      <Route path="usage" element={<h1>Usage</h1>} />
      <Route path="logs" element={<h1>Logs</h1>} />
    </Route>
  </Routes>
);

test("Settings opens on LLM and links to every settings area", () => {
  const page = renderPage(settingsRoutes, freshInstall, { path: "/settings" });
  assert.deepEqual(page.links, [
    "LLM Connection",
    "Translation Engine",
    "Corrections",
    "Sources & Monitoring",
    "Speech-to-text",
    "YouTube",
    "Interface",
    "Languages",
    "Usage",
    "Logs",
  ]);
  assert.match(page.html, /<a[^>]*aria-current="page"[^>]*>LLM Connection<\/a>/);
  assert.ok(page.headings.includes("LLM Connection"));
  assert.ok(page.buttons.includes("+ Add connection"));
  assert.ok(page.text.includes(`SubSmelt v${TEST_APP_VERSION}`));
});

test("desktop settings subpages keep the rail and mark their active destination", () => {
  for (const [path, label] of [
    ["languages", "Languages"],
    ["usage", "Usage"],
    ["logs", "Logs"],
  ]) {
    const page = renderPage(settingsRoutes, freshInstall, { path: `/settings/${path}` });
    assert.ok(page.links.includes("Translation Engine"));
    assert.ok(page.headings.includes(label));
    assert.match(page.html, new RegExp(`<a[^>]*aria-current="page"[^>]*>${label}</a>`));
  }
});

test("phones keep a route back to the settings sections and links to neighboring pages", () => {
  const page = renderPage(settingsRoutes, freshInstall, { path: "/settings/logs", isMobile: true });
  assert.deepEqual(page.links, ["Settings", "Languages", "Usage", "Logs"]);
  assert.match(page.html, /<a[^>]*aria-current="page"[^>]*>Logs<\/a>/);
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

test("Interface offers subtitle warnings unchecked by default", () => {
  const page = renderPage(settingsRoutes, freshInstall, { path: "/settings?section=iface" });
  assert.match(page.html, /Show subtitle warnings[\s\S]*?<input type="checkbox"[^>]*><\/label>/);
  assert.doesNotMatch(page.html, /type="checkbox"[^>]*checked=/);
});
