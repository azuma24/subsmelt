import test from "node:test";
import assert from "node:assert/strict";
import type { CorrectionRuleSet } from "../../../shared/corrections";
import { listsForFolder, lowercaseTwin, newRule, parseQuickAdd, ruleTags, setListForFolder } from "./model";

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
