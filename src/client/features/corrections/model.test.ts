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
    list("parent", ["AnKor"]),
    list("own", ["AnKor/Shorts"]),
    list("all", [""]),
  ];
  const rows = listsForFolder(lists, "AnKor/Shorts");
  assert.deepEqual(
    rows.map((r) => [r.list.id, r.direct, r.inheritedFrom]),
    [
      ["parent", false, "AnKor"],
      ["own", true, null],
      ["all", false, ""],
      ["other", false, null],
    ],
  );
});

test("a switched-off list does not count as applying", () => {
  const rows = listsForFolder([list("off", ["AnKor"], false), list("on", ["AnKor"])], "AnKor");
  assert.deepEqual(
    rows.map((r) => r.list.id),
    ["on", "off"],
  );
});

test("switching a list for a folder touches only that folder", () => {
  const lists = [list("a", ["Movies"])];
  assert.deepEqual(setListForFolder(lists, "a", "AnKor", true)[0].paths, ["Movies", "AnKor"]);
  assert.deepEqual(setListForFolder(lists, "a", "Movies", false)[0].paths, []);
});

test("quick add reads arrows, => and tabs, one pair per line", () => {
  assert.deepEqual(parseQuickAdd("Serenity → Sereniti\nAnchor -> Ankor\r\nfoo=>bar\nA\tB\nno separator\n → x"), [
    { find: "Serenity", replace: "Sereniti" },
    { find: "Anchor", replace: "Ankor" },
    { find: "foo", replace: "bar" },
    { find: "A", replace: "B" },
  ]);
});

test("a capitalised whole-word rule offers its lowercase twin once", () => {
  const rule = newRule("Anchor", "Ankor");
  assert.deepEqual(lowercaseTwin(rule, [rule]), { find: "anchor", replace: "ankor" });
  assert.equal(lowercaseTwin(rule, [rule, newRule("anchor", "ankor")]), null);
  assert.equal(lowercaseTwin(newRule("anchor", "ankor"), []), null);
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
  assert.deepEqual(ancestorFolders("AnKor/Tutorials/2024"), ["AnKor/Tutorials/2024", "AnKor/Tutorials", "AnKor", ""]);
  assert.deepEqual(ancestorFolders(""), [""]);
});

test("Chinese, Japanese and Thai terms default to matching anywhere", () => {
  assert.equal(defaultMatchFor("Serenity"), "word");
  assert.equal(defaultMatchFor("賽瑞尼"), "phrase");
  assert.equal(defaultMatchFor("セレニティ"), "phrase");
  assert.equal(defaultMatchFor("Привет"), "word");
});

test("fixing a word adds it to the chosen list, switches the list on for the folder, and replaces a twin rule", () => {
  const lists = [list("sereniti", ["AnKor"])];
  const first = addRuleForFolder(lists, "AnKor/Shorts", "sereniti", newRule("Serenity", "Sereniti"), "x");
  assert.deepEqual(first[0].paths, ["AnKor", "AnKor/Shorts"]);
  assert.equal(first[0].rules.length, 1);
  const again = addRuleForFolder(first, "AnKor/Shorts", "sereniti", newRule("Serenity", "Sereniti!"), "x");
  assert.equal(again[0].rules.length, 1);
  assert.equal(again[0].rules[0].replace, "Sereniti!");
  const fresh = addRuleForFolder(lists, "Movies", null, newRule("Jedy", "Jedi"), "Movies");
  assert.deepEqual(
    fresh.map((l) => [l.name, l.paths, l.rules.length]),
    [
      ["sereniti", ["AnKor"], 0],
      ["Movies", ["Movies"], 1],
    ],
  );
});

test("replacing a twin rule keeps the files it already leaves alone", () => {
  const lists = [
    { ...list("sereniti", ["AnKor"]), rules: [{ ...newRule("Serenity", "Sereniti"), except: ["AnKor/a.srt"] }] },
  ];
  const next = addRuleForFolder(
    lists,
    "AnKor",
    "sereniti",
    { ...newRule("Serenity", "Sereniti"), except: ["AnKor/b.srt"] },
    "x",
  );
  assert.deepEqual(next[0].rules[0].except, ["AnKor/a.srt", "AnKor/b.srt"]);
});
