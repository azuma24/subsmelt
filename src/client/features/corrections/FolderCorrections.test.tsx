import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import { FolderCorrections } from "./FolderCorrections";

const LISTS = JSON.stringify([
  {
    id: "sereniti",
    name: "Sereniti",
    enabled: true,
    paths: ["AnKor"],
    rules: [{ id: "r1", find: "Serenity", replace: "Sereniti" }],
  },
  { id: "movies", name: "Star Wars", enabled: true, paths: ["Movies"], rules: [] },
]);

test("a subfolder shows the parent's list as inherited and other lists as off", () => {
  const page = renderPage(<FolderCorrections folder="AnKor/Tutorials" />, [
    [["settings"], { correction_rule_sets: LISTS }],
  ]);
  assert.ok(page.text.includes("Sereniti"));
  assert.ok(page.text.includes("1 rule · from AnKor"));
  assert.ok(page.text.includes("Star Wars"));
  assert.ok(page.buttons.includes("New list for this folder"));
  // Sereniti is ticked (inherited, so not switchable here); Star Wars is not.
  assert.equal(page.html.match(/checked=""/g)?.length, 1);
});

test("a folder with no lists invites starting one", () => {
  const page = renderPage(<FolderCorrections folder="Movies" />, [[["settings"], { correction_rule_sets: "[]" }]]);
  assert.ok(page.text.includes("No correction lists yet."));
});
