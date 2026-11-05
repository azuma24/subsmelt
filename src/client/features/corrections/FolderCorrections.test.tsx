import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import { FolderCorrections } from "./FolderCorrections";

const LISTS = JSON.stringify([
  {
    id: "ubnt",
    name: "Ubiquiti",
    enabled: true,
    paths: ["UniFi"],
    rules: [{ id: "r1", find: "Ubiquity", replace: "Ubiquiti" }],
  },
  { id: "movies", name: "Star Wars", enabled: true, paths: ["Movies"], rules: [] },
]);

test("a subfolder shows the parent's list as inherited and other lists as off", () => {
  const page = renderPage(<FolderCorrections folder="UniFi/Tutorials" />, [
    [["settings"], { correction_rule_sets: LISTS }],
  ]);
  assert.ok(page.text.includes("Ubiquiti"));
  assert.ok(page.text.includes("1 rule · from UniFi"));
  assert.ok(page.text.includes("Star Wars"));
  assert.ok(page.buttons.includes("New list for this folder"));
  // Ubiquiti is ticked (inherited, so not switchable here); Star Wars is not.
  assert.equal(page.html.match(/checked=""/g)?.length, 1);
});

test("a folder with no lists invites starting one", () => {
  const page = renderPage(<FolderCorrections folder="Movies" />, [[["settings"], { correction_rule_sets: "[]" }]]);
  assert.ok(page.text.includes("No correction lists yet."));
});
