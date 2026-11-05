import test from "node:test";
import assert from "node:assert/strict";
import {
  compileCorrectionsFor,
  correctCueText,
  correctionGlossaryTerms,
  correctionRuleSetsErrors,
  correctionRuleSetsIssues,
  describeCorrectionIssue,
  parseCorrectionRuleSets,
  type CorrectionRule,
  type CorrectionRuleSet,
} from "./corrections.js";

function rule(find: string, replace: string, extra: Partial<CorrectionRule> = {}): CorrectionRule {
  return {
    id: `${find}->${replace}`,
    find,
    replace,
    stage: "both",
    match: "word",
    caseSensitive: true,
    languages: [],
    enabled: true,
    ...extra,
  };
}

const SERENITI: CorrectionRuleSet = {
  id: "sereniti",
  name: "Sereniti",
  enabled: true,
  paths: ["AnKor"],
  rules: [rule("Anchor", "Ankor"), rule("anchor", "ankor"), rule("Serenity", "Sereniti")],
};

const compiled = compileCorrectionsFor([SERENITI], "AnKor/ep1.chi.srt", "output");
const fix = (text: string) => correctCueText(text, compiled);

test("the three Sereniti rules replace whole words and count per rule", () => {
  assert.deepEqual(fix("Anchor Network"), { text: "Ankor Network", counts: { "Anchor->Ankor": 1 } });
  assert.deepEqual(fix("使用 anchor。"), { text: "使用 ankor。", counts: { "anchor->ankor": 1 } });
  assert.deepEqual(fix("Serenity, Inc."), { text: "Sereniti, Inc.", counts: { "Serenity->Sereniti": 1 } });
});

test("several matches in one cue are all counted and punctuation is kept", () => {
  assert.deepEqual(fix("Anchor, Anchor! (Anchor)"), { text: "Ankor, Ankor! (Ankor)", counts: { "Anchor->Ankor": 3 } });
});

test("case variants, longer words, digit/underscore and CJK adjacency stay unchanged", () => {
  for (const text of ["AnchorCloud", "my_Anchor", "ANCHOR", "Serenity2", "超級Anchor網路", "serenity"]) {
    assert.deepEqual(fix(text), { text, counts: {} }, text);
  }
});

test("a term split across lines or by markup is not a match; markup itself is never touched", () => {
  assert.equal(fix("Uni\nfy").text, "Uni\nfy");
  assert.equal(fix("Uni<i>fy</i>").text, "Uni<i>fy</i>");
  assert.equal(fix("<i>Anchor</i>").text, "<i>Ankor</i>");
  assert.equal(fix("{\\i1}Anchor{\\i0}\\NSerenity").text, "{\\i1}Ankor{\\i0}\\NSereniti");
  assert.equal(fix('<font color="Anchor">x</font>').text, '<font color="Anchor">x</font>');
  assert.equal(fix("line one\r\nAnchor").text, "line one\r\nAnkor");
});

test("a second run changes nothing", () => {
  const once = fix("Anchor and Serenity and anchor").text;
  assert.deepEqual(fix(once), { text: once, counts: {} });
});

test("phrase mode matches inside text without spaces (Chinese output)", () => {
  const set: CorrectionRuleSet = {
    ...SERENITI,
    rules: [rule("賽瑞尼", "Sereniti", { match: "phrase", stage: "output" })],
  };
  const rules = compileCorrectionsFor([set], "AnKor/a.srt", "output");
  assert.equal(correctCueText("我們的賽瑞尼路由器", rules).text, "我們的Sereniti路由器");
});

test("case-insensitive canonicalising rules do not count matches already in canonical form", () => {
  const set: CorrectionRuleSet = { ...SERENITI, rules: [rule("ankor", "AnKor", { caseSensitive: false })] };
  const rules = compileCorrectionsFor([set], "AnKor/a.srt", "source");
  assert.deepEqual(correctCueText("ankor ANKOR AnKor", rules), {
    text: "AnKor AnKor AnKor",
    counts: { "ankor->AnKor": 2 },
  });
});

test("regex rules expand groups", () => {
  const set: CorrectionRuleSet = {
    ...SERENITI,
    rules: [rule("A(\\d)-Pro", "A$1 Pro", { match: "regex" })],
  };
  const rules = compileCorrectionsFor([set], "AnKor/a.srt", "source");
  assert.equal(correctCueText("the A7-Pro and A6-Pro", rules).text, "the A7 Pro and A6 Pro");
});

test("sets apply only inside their folders, and stage and language filter the rules", () => {
  const set: CorrectionRuleSet = {
    ...SERENITI,
    rules: [rule("a", "b", { stage: "source" }), rule("c", "d", { stage: "output", languages: ["chi"] })],
  };
  assert.equal(compileCorrectionsFor([set], "Movies/x.srt", "source").length, 0);
  assert.equal(compileCorrectionsFor([set], "AnKorStuff/x.srt", "source").length, 0);
  assert.equal(compileCorrectionsFor([set], "AnKor/sub/x.srt", "source").length, 1);
  assert.equal(compileCorrectionsFor([set], "AnKor/x.srt", "output", ["jpn"]).length, 0);
  assert.equal(compileCorrectionsFor([set], "AnKor/x.srt", "output", ["chi", "zh-TW"]).length, 1);
  assert.equal(compileCorrectionsFor([{ ...set, enabled: false }], "AnKor/x.srt", "source").length, 0);
  assert.equal(compileCorrectionsFor([{ ...set, paths: [""] }], "Movies/x.srt", "source").length, 1);
});

test("saving refuses unstable, empty and invalid rules", () => {
  const save = (rules: CorrectionRule[], paths = ["AnKor"]) =>
    correctionRuleSetsErrors(JSON.stringify([{ ...SERENITI, paths, rules }]));
  assert.deepEqual(save(SERENITI.rules), []);
  assert.match(save([rule("AnKor", "AnKor Network")]).join(), /changed again/);
  assert.match(save([rule("", "x")]).join(), /empty/);
  assert.match(save([rule("(", "x", { match: "regex" })]).join(), /Invalid regular expression/);
  assert.match(save([rule("a", "b"), rule("b", "a")]).join(), /keep changing/);
  assert.match(save(SERENITI.rules, []).join(), /folder/);
  assert.deepEqual(correctionRuleSetsErrors("{"), ["Correction rules must be valid JSON"]);
});

test("parsing drops malformed entries and keeps folders inside the library", () => {
  const sets = parseCorrectionRuleSets(
    JSON.stringify([
      { id: "a", paths: ["/AnKor/", "../etc", "x/../y"], rules: [{ id: "r", find: "x" }, { find: "no id" }] },
      "junk",
    ]),
  );
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].paths, ["AnKor", "y"]);
  assert.equal(sets[0].rules.length, 1);
  assert.equal(sets[0].rules[0].caseSensitive, true);
  assert.equal(sets[0].rules[0].match, "word");
});

test("glossary terms are the plain rules' replacements, once each", () => {
  assert.deepEqual(correctionGlossaryTerms(compiled), ["Ankor", "Sereniti"]);
});

test("regex replacements expand exactly as String.prototype.replace does", () => {
  const cases: Array<[string, string, string]> = [
    ["(U)(\\d)", "$2$1", "U7 and U6"],
    ["(U)", "$10", "U7"], // one group: $1 then a literal 0
    ["(?<m>U)(\\d)", "[$<m>|$2]", "U7"],
    ["U", "$<x>", "U7"], // no named groups: $<x> stays literal
    ["U", "<$`|$'|$&|$$>", "aUb"],
    ["U", "$0$3", "U"], // out of range: literal
  ];
  for (const [find, replace, text] of cases) {
    const set: CorrectionRuleSet = { ...SERENITI, rules: [rule(find, replace, { match: "regex" })] };
    const rules = compileCorrectionsFor([set], "AnKor/a.srt", "source");
    assert.equal(
      correctCueText(text, rules).text,
      text.replace(new RegExp(find, "gu"), replace),
      `${find} → ${replace}`,
    );
  }
});

test("lookahead-only patterns are refused, and a zero-length match never inserts text", () => {
  assert.match(
    correctionRuleSetsErrors(
      JSON.stringify([{ ...SERENITI, rules: [rule("(?=Ubiq)", "X", { match: "regex" })] }]),
    ).join(),
    /empty text/,
  );
  const zero = { rule: rule("(?=Ubiq)", "X", { match: "regex" }), setName: "", pattern: /(?=Ubiq)/gu };
  assert.deepEqual(correctCueText("Serenity", [zero]), { text: "Serenity", counts: {} });
});

test("only name-like replacements are pinned in the glossary", () => {
  const set: CorrectionRuleSet = {
    ...SERENITI,
    rules: [rule("teh", "the"), rule("Serenity", "Sereniti"), rule("a7pro", "A7 Pro"), rule("賽瑞尼", "賽瑞尼")],
  };
  assert.deepEqual(correctionGlossaryTerms(compileCorrectionsFor([set], "AnKor/a", "source")), [
    "Sereniti",
    "A7 Pro",
    "賽瑞尼",
  ]);
});

test("lists that undo each other where both apply are refused on save", () => {
  const a: CorrectionRuleSet = { id: "a", name: "A", enabled: true, paths: ["TV"], rules: [rule("Anchor", "AnKor")] };
  const b: CorrectionRuleSet = { id: "b", name: "B", enabled: true, paths: [""], rules: [rule("AnKor", "Anchor")] };
  assert.match(correctionRuleSetsErrors(JSON.stringify([a, b])).join(), /Lists "A" and "B" undo each other in TV/);
  // Apart, they are fine.
  assert.deepEqual(correctionRuleSetsErrors(JSON.stringify([a, { ...b, paths: ["Movies"] }])), []);
});

test("output lists limited to different languages never conflict, but do when they share one", () => {
  const out = (id: string, find: string, replace: string, languages: string[]): CorrectionRuleSet => ({
    id,
    name: id,
    enabled: true,
    paths: [""],
    rules: [rule(find, replace, { stage: "output", languages })],
  });
  assert.deepEqual(
    correctionRuleSetsErrors(
      JSON.stringify([out("zh", "Anchor", "AnKor", ["chi"]), out("ja", "AnKor", "Anchor", ["jpn"])]),
    ),
    [],
  );
  assert.match(
    correctionRuleSetsErrors(
      JSON.stringify([out("zh", "Anchor", "AnKor", ["chi"]), out("all", "AnKor", "Anchor", [])]),
    ).join(),
    /undo each other/,
  );
});

test("a rule's exceptions skip exactly those files", () => {
  const set: CorrectionRuleSet = {
    ...SERENITI,
    rules: [rule("Serenity", "Sereniti", { except: ["AnKor/Essay.srt"] })],
  };
  assert.equal(compileCorrectionsFor([set], "AnKor/Essay.srt", "source").length, 0);
  assert.equal(compileCorrectionsFor([set], "AnKor/Talk.srt", "source").length, 1);
  const parsed = parseCorrectionRuleSets(
    JSON.stringify([{ ...set, rules: [{ ...set.rules[0], except: ["/AnKor/Essay.srt", "../x", "AnKor/Essay.srt"] }] }]),
  );
  assert.deepEqual(parsed[0].rules[0].except, ["AnKor/Essay.srt"]);
});

test("issues carry a code and what they are about, and still read in English", () => {
  const issues = correctionRuleSetsIssues(JSON.stringify([{ ...SERENITI, rules: [rule("AnKor", "AnKor Network")] }]));
  assert.deepEqual(issues, [{ code: "unstableSelf", find: "AnKor", list: "Sereniti" }]);
  assert.equal(
    describeCorrectionIssue(issues[0]),
    'Sereniti: "AnKor": The replacement would be changed again by this rule',
  );
});
