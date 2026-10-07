import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../test-render";
import { DesktopSidebar, MobileBottomNav } from "./shell";
import { isNavActive, NAV_ITEMS } from "./constants";
import { legacyRedirect } from "./redirects";
import { SettingsSubpageLinks } from "../features/settings/SettingsSubpageLinks";

const ORDER = ["Library", "Activity", "Transcribe", "YouTube", "Settings"];

test("the sidebar lists the five destinations in order", () => {
  const page = renderPage(
    <DesktopSidebar queueRunning={false} errorCount={0} watcherRunning={false} currentPath="/" />,
  );
  assert.deepEqual(page.links, ORDER);
});

test("the sidebar's LLM line opens the connection list", () => {
  const llmStatus = {
    mode: "fallback",
    connections: ["a", "b", "c"].map((id) => ({ id, label: id, model: "m", host: "h", state: "idle", jobIds: [] })),
  };
  const page = renderPage(
    <DesktopSidebar queueRunning={false} errorCount={0} watcherRunning={false} currentPath="/" />,
    [[["llm-status"], llmStatus]],
  );
  assert.ok(page.buttons.includes("LLM · Fallback · 3 connections"));
  assert.match(page.html, /aria-expanded="false"/);
});

test("the phone bar holds exactly the same five destinations and no More sheet", () => {
  const page = renderPage(<MobileBottomNav currentPath="/activity" />);
  assert.deepEqual(page.links, ORDER);
  assert.deepEqual(page.buttons, []);
  assert.ok(!page.text.includes("More"));
});

test("failed jobs badge the Activity item", () => {
  const page = renderPage(
    <DesktopSidebar queueRunning={false} errorCount={3} watcherRunning={false} currentPath="/" />,
  );
  assert.deepEqual(page.links, ["Library", "Activity 3", "Transcribe", "YouTube", "Settings"]);
});

test("settings sub-pages keep Settings active; Library is active only at the root", () => {
  const active = (path: string) => NAV_ITEMS.filter((item) => isNavActive(item, path)).map((item) => item.path);
  assert.deepEqual(active("/"), ["/"]);
  assert.deepEqual(active("/settings/logs"), ["/settings"]);
  assert.deepEqual(active("/settings/languages"), ["/settings"]);
  assert.deepEqual(active("/settings/usage"), ["/settings"]);
  assert.deepEqual(active("/activity"), ["/activity"]);
  assert.deepEqual(active("/convert"), []);
});

test("old Translations and Logs URLs redirect into Settings, keeping the query", () => {
  assert.equal(legacyRedirect("/translations", ""), "/settings/languages");
  assert.equal(legacyRedirect("/tasks", ""), "/settings/languages");
  assert.equal(legacyRedirect("/logs", "?job=12"), "/settings/logs?job=12");
  assert.equal(legacyRedirect("/settings", ""), null);
});

test("Settings links its own pages in order: Languages, Usage, Logs", () => {
  const page = renderPage(<SettingsSubpageLinks variant="rows" />);
  assert.deepEqual(page.links, ["Languages", "Usage", "Logs"]);
  assert.match(page.html, /href="\/settings\/usage"/);
});
