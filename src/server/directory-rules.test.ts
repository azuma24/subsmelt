import assert from "node:assert/strict";
import test from "node:test";

import { parseRules, resolveDirectoryRule, type DirectoryRule } from "./directory-rules.js";

test("parseRules: empty / invalid input yields empty array", () => {
  assert.deepEqual(parseRules(""), []);
  assert.deepEqual(parseRules("[]"), []);
  assert.deepEqual(parseRules("not json"), []);
  assert.deepEqual(parseRules("{}"), []);
  assert.deepEqual(parseRules("null"), []);
});

test("parseRules: normalizes path and coerces fields", () => {
  const rules = parseRules(JSON.stringify([
    { id: "a", path: "/Anime/JP/", enabled: true, translateWithoutVideo: "on", taskIds: [1, 2] },
  ]));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].path, "Anime/JP");
  assert.equal(rules[0].enabled, true);
  assert.equal(rules[0].translateWithoutVideo, "on");
  assert.deepEqual(rules[0].taskIds, [1, 2]);
});

test("parseRules: drops malformed entries and bad tri-state falls back to inherit", () => {
  const rules = parseRules(JSON.stringify([
    { id: "ok", path: "a", enabled: 1, translateWithoutVideo: "bogus", taskIds: [3, "x", 4] },
    { path: "missing-id" },
    "garbage",
    42,
  ]));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "ok");
  assert.equal(rules[0].enabled, true);
  assert.equal(rules[0].translateWithoutVideo, "inherit");
  assert.deepEqual(rules[0].taskIds, [3, 4]);
});

test("parseRules: backslash and dot segments rejected/normalized; escaping path dropped", () => {
  const rules = parseRules(JSON.stringify([
    { id: "win", path: "Anime\\\\Sub", enabled: true, translateWithoutVideo: "off", taskIds: [] },
    { id: "esc", path: "../secret", enabled: true, translateWithoutVideo: "on", taskIds: [] },
  ]));
  const win = rules.find((r) => r.id === "win");
  assert.ok(win);
  assert.equal(win!.path, "Anime/Sub");
  assert.equal(rules.find((r) => r.id === "esc"), undefined);
});

const rule = (over: Partial<DirectoryRule>): DirectoryRule => ({
  id: "id",
  path: "",
  enabled: true,
  translateWithoutVideo: "inherit",
  taskIds: [],
  ...over,
});

test("resolveDirectoryRule: no rules → global default, no extra tasks", () => {
  const offDefault = resolveDirectoryRule("Anime/Show", [], false);
  assert.equal(offDefault.translateWithoutVideo, false);
  assert.deepEqual(offDefault.extraTaskIds, []);
  assert.equal(offDefault.matchedRuleId, null);

  const onDefault = resolveDirectoryRule("Anime/Show", [], true);
  assert.equal(onDefault.translateWithoutVideo, true);
});

test("resolveDirectoryRule: root rule (path '') matches everything", () => {
  const rules = [rule({ id: "root", path: "", translateWithoutVideo: "on" })];
  const r = resolveDirectoryRule("Anime/Show/S1", rules, false);
  assert.equal(r.translateWithoutVideo, true);
  assert.equal(r.matchedRuleId, "root");
});

test("resolveDirectoryRule: non-matching prefix is ignored", () => {
  const rules = [rule({ id: "a", path: "Dramas", translateWithoutVideo: "on" })];
  const r = resolveDirectoryRule("Anime/Show", rules, false);
  assert.equal(r.translateWithoutVideo, false);
  assert.equal(r.matchedRuleId, null);
});

test("resolveDirectoryRule: longest prefix wins for videoless flag", () => {
  const rules = [
    rule({ id: "broad", path: "Anime", translateWithoutVideo: "off" }),
    rule({ id: "deep", path: "Anime/JP", translateWithoutVideo: "on" }),
  ];
  const r = resolveDirectoryRule("Anime/JP/Show", rules, false);
  assert.equal(r.translateWithoutVideo, true);
  assert.equal(r.matchedRuleId, "deep");
});

test("resolveDirectoryRule: inherit falls through to ancestor then global", () => {
  const rules = [
    rule({ id: "broad", path: "Anime", translateWithoutVideo: "on" }),
    rule({ id: "deep", path: "Anime/JP", translateWithoutVideo: "inherit" }),
  ];
  // deep matches but inherits → falls to broad (on)
  assert.equal(resolveDirectoryRule("Anime/JP/Show", rules, false).translateWithoutVideo, true);
  // both inherit → global default
  const allInherit = [rule({ id: "broad", path: "Anime", translateWithoutVideo: "inherit" })];
  assert.equal(resolveDirectoryRule("Anime/JP", allInherit, false).translateWithoutVideo, false);
  assert.equal(resolveDirectoryRule("Anime/JP", allInherit, true).translateWithoutVideo, true);
});

test("resolveDirectoryRule: extra task IDs union across all matching rules, deduped", () => {
  const rules = [
    rule({ id: "broad", path: "Anime", taskIds: [1, 2] }),
    rule({ id: "deep", path: "Anime/JP", taskIds: [2, 3] }),
    rule({ id: "other", path: "Dramas", taskIds: [9] }),
  ];
  const r = resolveDirectoryRule("Anime/JP/Show", rules, false);
  assert.deepEqual([...r.extraTaskIds].sort((a, b) => a - b), [1, 2, 3]);
});

test("resolveDirectoryRule: disabled rules are ignored", () => {
  const rules = [
    rule({ id: "off", path: "Anime", enabled: false, translateWithoutVideo: "on", taskIds: [5] }),
  ];
  const r = resolveDirectoryRule("Anime/Show", rules, false);
  assert.equal(r.translateWithoutVideo, false);
  assert.deepEqual(r.extraTaskIds, []);
  assert.equal(r.matchedRuleId, null);
});

test("resolveDirectoryRule: exact directory match (no trailing segment)", () => {
  const rules = [rule({ id: "exact", path: "Anime/JP", translateWithoutVideo: "on" })];
  assert.equal(resolveDirectoryRule("Anime/JP", rules, false).translateWithoutVideo, true);
  // sibling that shares a name prefix must NOT match
  assert.equal(resolveDirectoryRule("Anime/JPx", rules, false).translateWithoutVideo, false);
});
