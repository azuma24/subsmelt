import test from "node:test";
import assert from "node:assert/strict";
import type { CorrectionRuleSet } from "../../../shared/corrections";
import {
  addRuleForFolder,
  ancestorFolders,
  defaultMatchFor,
  listsForFolder,
  lowercaseTwin,
  newRule,
  parseQuickAdd,
  ruleTags,
  setListForFolder,
} from "./model";

const list = (id: string, paths: string[], enabled = true): CorrectionRuleSet => ({
  id,
  name: id,
  enabled,
  paths,
  rules: [],
});

test("a folder sees its own lists, then inherited ones, then the rest", () => {
  const lists = [
    list("other", ["Movies"]),
    list("parent", ["UniFi"]),
    list("own", ["UniFi/Shorts"]),
    list("all", [""]),
  ];
  const rows = listsForFolder(lists, "UniFi/Shorts");
  assert.deepEqual(
    rows.map((r) => [r.list.id, r.direct, r.inheritedFrom]),
    [
      ["parent", false, "UniFi"],
      ["own", true, null],
      ["all", false, ""],
      ["other", false, null],
    ],
  );
});

test("a switched-off list does not count as applying", () => {
  const rows = listsForFolder([list("off", ["UniFi"], false), list("on", ["UniFi"])], "UniFi");
  assert.deepEqual(
    rows.map((r) => r.list.id),
    ["on", "off"],
  );
});

test("switching a list for a folder touches only that folder", () => {
  const lists = [list("a", ["Movies"])];
  assert.deepEqual(setListForFolder(lists, "a", "UniFi", true)[0].paths, ["Movies", "UniFi"]);
  assert.deepEqual(setListForFolder(lists, "a", "Movies", false)[0].paths, []);
});

test("quick add reads arrows, => and tabs, one pair per line", () => {
  assert.deepEqual(parseQuickAdd("Ubiquity → Ubiquiti\nUnify -> Unifi\r\nfoo=>bar\nA\tB\nno separator\n → x"), [
    { find: "Ubiquity", replace: "Ubiquiti" },
    { find: "Unify", replace: "Unifi" },
    { find: "foo", replace: "bar" },
    { find: "A", replace: "B" },
  ]);
});

test("a capitalised whole-word rule offers its lowercase twin once", () => {
  const rule = newRule("Unify", "Unifi");
  assert.deepEqual(lowercaseTwin(rule, [rule]), { find: "unify", replace: "unifi" });
  assert.equal(lowercaseTwin(rule, [rule, newRule("unify", "unifi")]), null);
  assert.equal(lowercaseTwin(newRule("unify", "unifi"), []), null);
  assert.equal(lowercaseTwin({ ...rule, caseSensitive: false }, [rule]), null);
});

test("collapsed rows tag only what differs from the defaults", () => {
  assert.deepEqual(ruleTags(newRule("a", "b")), []);
  assert.deepEqual(ruleTags({ ...newRule("a", "b"), stage: "output", match: "phrase", languages: ["chi"] }), [
    "output",
    "phrase",
    "langs",
  ]);
});

test("a folder's ancestors run from itself up to the whole library", () => {
  assert.deepEqual(ancestorFolders("UniFi/Tutorials/2024"), ["UniFi/Tutorials/2024", "UniFi/Tutorials", "UniFi", ""]);
  assert.deepEqual(ancestorFolders(""), [""]);
});

test("Chinese, Japanese and Thai terms default to matching anywhere", () => {
  assert.equal(defaultMatchFor("Ubiquity"), "word");
  assert.equal(defaultMatchFor("優比快"), "phrase");
  assert.equal(defaultMatchFor("ユビキティ"), "phrase");
  assert.equal(defaultMatchFor("Привет"), "word");
});

test("fixing a word adds it to the chosen list, switches the list on for the folder, and replaces a twin rule", () => {
  const lists = [list("ubnt", ["UniFi"])];
  const first = addRuleForFolder(lists, "UniFi/Shorts", "ubnt", newRule("Ubiquity", "Ubiquiti"), "x");
  assert.deepEqual(first[0].paths, ["UniFi", "UniFi/Shorts"]);
  assert.equal(first[0].rules.length, 1);
  const again = addRuleForFolder(first, "UniFi/Shorts", "ubnt", newRule("Ubiquity", "Ubiquiti!"), "x");
  assert.equal(again[0].rules.length, 1);
  assert.equal(again[0].rules[0].replace, "Ubiquiti!");
  const fresh = addRuleForFolder(lists, "Movies", null, newRule("Jedy", "Jedi"), "Movies");
  assert.deepEqual(
    fresh.map((l) => [l.name, l.paths, l.rules.length]),
    [
      ["ubnt", ["UniFi"], 0],
      ["Movies", ["Movies"], 1],
    ],
  );
});
