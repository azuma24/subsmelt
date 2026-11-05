import test from "node:test";
import assert from "node:assert/strict";
import { compileCorrectionsFor, type CorrectionRule, type CorrectionRuleSet } from "../../shared/corrections.js";
import { checkCorrections, parseAnswers } from "./correction-check.js";

function rules(...list: CorrectionRule[]) {
  const set: CorrectionRuleSet = { id: "s", name: "s", enabled: true, paths: [""], rules: list };
  return compileCorrectionsFor([set], "a.srt", "source");
}
const unify: CorrectionRule = {
  id: "unify",
  find: "unify",
  replace: "UniFi",
  stage: "source",
  match: "word",
  caseSensitive: true,
  languages: [],
  enabled: true,
  confirm: true,
};

const TEXTS = ["Open the unify app", "We unify the dashboards", "Nothing here", "unify, then unify again"];

/** A stand-in LLM: says yes to the lines that mention an app. */
function brandOnly(prompt: string): Promise<string> {
  const items = JSON.parse(prompt.slice(prompt.indexOf("[\n"))) as Array<{ id: number; line: string }>;
  return Promise.resolve(JSON.stringify(items.map((item) => ({ id: item.id, replace: /app/.test(item.line) }))));
}

test("only confirmed matches are replaced; the rest are kept and counted", async () => {
  const result = await checkCorrections(TEXTS, rules(unify), brandOnly);
  assert.deepEqual(result.texts, [
    "Open the UniFi app",
    "We unify the dashboards",
    "Nothing here",
    "unify, then unify again",
  ]);
  assert.deepEqual(result.confirmed, { unify: 1 });
  assert.deepEqual(result.kept, { unify: 3 });
  assert.equal(result.failedBatches, 0);
});

test("the question marks the term and carries the neighbouring lines", async () => {
  let prompt = "";
  await checkCorrections(TEXTS, rules(unify), (p) => {
    prompt = p;
    return Promise.resolve("[]");
  });
  const items = JSON.parse(prompt.slice(prompt.indexOf("[\n")));
  assert.deepEqual(items[1], {
    id: 1,
    before: "Open the unify app",
    line: "We «unify» the dashboards",
    after: "Nothing here",
    term: "unify",
    replaceWith: "UniFi",
  });
});

test("a failed request or a garbled answer keeps everything as written", async () => {
  const failed = await checkCorrections(TEXTS, rules(unify), () => Promise.reject(new Error("boom")));
  assert.deepEqual(failed.texts, TEXTS);
  assert.equal(failed.failedBatches, 1);
  const garbled = await checkCorrections(TEXTS, rules(unify), () => Promise.resolve("sure, replace them all"));
  assert.deepEqual(garbled.texts, TEXTS);
});

test("a stop or cancel is not swallowed", async () => {
  await assert.rejects(
    checkCorrections(TEXTS, rules(unify), () => Promise.reject(new Error("STOP_REQUESTED"))),
    /STOP_REQUESTED/,
  );
});

test("matches are sent in batches of 40", async () => {
  const many = Array.from({ length: 95 }, () => "the unify app");
  let calls = 0;
  const result = await checkCorrections(many, rules(unify), (p) => {
    calls++;
    return brandOnly(p);
  });
  assert.equal(calls, 3);
  assert.ok(result.texts.every((t) => t === "the UniFi app"));
});

test("answers are read from a bare array, a fenced block or an answers object, and junk is ignored", () => {
  assert.deepEqual([...parseAnswers('[{"id":0,"replace":true}]')], [[0, true]]);
  assert.deepEqual([...parseAnswers('```json\n{"answers":[{"id":2,"replace":false}]}\n```')], [[2, false]]);
  assert.deepEqual([...parseAnswers('[{"id":"0","replace":"yes"},{"id":1}]')], []);
});
