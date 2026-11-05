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

const UBIQUITI: CorrectionRuleSet = {
  id: "ubnt",
  name: "Ubiquiti",
  enabled: true,
  paths: ["UniFi"],
  rules: [rule("Unify", "Unifi"), rule("unify", "unifi"), rule("Ubiquity", "Ubiquiti")],
};

const compiled = compileCorrectionsFor([UBIQUITI], "UniFi/ep1.chi.srt", "output");
const fix = (text: string) => correctCueText(text, compiled);

test("the three Ubiquiti rules replace whole words and count per rule", () => {
  assert.deepEqual(fix("Unify Network"), { text: "Unifi Network", counts: { "Unify->Unifi": 1 } });
  assert.deepEqual(fix("使用 unify。"), { text: "使用 unifi。", counts: { "unify->unifi": 1 } });
  assert.deepEqual(fix("Ubiquity, Inc."), { text: "Ubiquiti, Inc.", counts: { "Ubiquity->Ubiquiti": 1 } });
});

test("several matches in one cue are all counted and punctuation is kept", () => {
  assert.deepEqual(fix("Unify, Unify! (Unify)"), { text: "Unifi, Unifi! (Unifi)", counts: { "Unify->Unifi": 3 } });
});

test("case variants, longer words, digit/underscore and CJK adjacency stay unchanged", () => {
  for (const text of ["UnifyCloud", "my_Unify", "UNIFY", "Ubiquity2", "超級Unify網路", "ubiquity"]) {
    assert.deepEqual(fix(text), { text, counts: {} }, text);
  }
});

test("a term split across lines or by markup is not a match; markup itself is never touched", () => {
  assert.equal(fix("Uni\nfy").text, "Uni\nfy");
  assert.equal(fix("Uni<i>fy</i>").text, "Uni<i>fy</i>");
  assert.equal(fix("<i>Unify</i>").text, "<i>Unifi</i>");
  assert.equal(fix("{\\i1}Unify{\\i0}\\NUbiquity").text, "{\\i1}Unifi{\\i0}\\NUbiquiti");
  assert.equal(fix('<font color="Unify">x</font>').text, '<font color="Unify">x</font>');
  assert.equal(fix("line one\r\nUnify").text, "line one\r\nUnifi");
});

test("a second run changes nothing", () => {
  const once = fix("Unify and Ubiquity and unify").text;
  assert.deepEqual(fix(once), { text: once, counts: {} });
});

test("phrase mode matches inside text without spaces (Chinese output)", () => {
  const set: CorrectionRuleSet = {
    ...UBIQUITI,
    rules: [rule("優比快", "Ubiquiti", { match: "phrase", stage: "output" })],
  };
  const rules = compileCorrectionsFor([set], "UniFi/a.srt", "output");
  assert.equal(correctCueText("我們的優比快路由器", rules).text, "我們的Ubiquiti路由器");
});

test("case-insensitive canonicalising rules do not count matches already in canonical form", () => {
  const set: CorrectionRuleSet = { ...UBIQUITI, rules: [rule("unifi", "UniFi", { caseSensitive: false })] };
  const rules = compileCorrectionsFor([set], "UniFi/a.srt", "source");
  assert.deepEqual(correctCueText("unifi UNIFI UniFi", rules), {
    text: "UniFi UniFi UniFi",
    counts: { "unifi->UniFi": 2 },
  });
});

test("regex rules expand groups", () => {
  const set: CorrectionRuleSet = {
    ...UBIQUITI,
    rules: [rule("U(\\d)-Pro", "U$1 Pro", { match: "regex" })],
  };
  const rules = compileCorrectionsFor([set], "UniFi/a.srt", "source");
  assert.equal(correctCueText("the U7-Pro and U6-Pro", rules).text, "the U7 Pro and U6 Pro");
});

test("sets apply only inside their folders, and stage and language filter the rules", () => {
  const set: CorrectionRuleSet = {
    ...UBIQUITI,
    rules: [rule("a", "b", { stage: "source" }), rule("c", "d", { stage: "output", languages: ["chi"] })],
  };
  assert.equal(compileCorrectionsFor([set], "Movies/x.srt", "source").length, 0);
  assert.equal(compileCorrectionsFor([set], "UniFiStuff/x.srt", "source").length, 0);
  assert.equal(compileCorrectionsFor([set], "UniFi/sub/x.srt", "source").length, 1);
  assert.equal(compileCorrectionsFor([set], "UniFi/x.srt", "output", ["jpn"]).length, 0);
  assert.equal(compileCorrectionsFor([set], "UniFi/x.srt", "output", ["chi", "zh-TW"]).length, 1);
  assert.equal(compileCorrectionsFor([{ ...set, enabled: false }], "UniFi/x.srt", "source").length, 0);
  assert.equal(compileCorrectionsFor([{ ...set, paths: [""] }], "Movies/x.srt", "source").length, 1);
});

test("saving refuses unstable, empty and invalid rules", () => {
  const save = (rules: CorrectionRule[], paths = ["UniFi"]) =>
    correctionRuleSetsErrors(JSON.stringify([{ ...UBIQUITI, paths, rules }]));
  assert.deepEqual(save(UBIQUITI.rules), []);
  assert.match(save([rule("UniFi", "UniFi Network")]).join(), /changed again/);
  assert.match(save([rule("", "x")]).join(), /empty/);
  assert.match(save([rule("(", "x", { match: "regex" })]).join(), /Invalid regular expression/);
  assert.match(save([rule("a", "b"), rule("b", "a")]).join(), /keep changing/);
  assert.match(save(UBIQUITI.rules, []).join(), /folder/);
  assert.deepEqual(correctionRuleSetsErrors("{"), ["Correction rules must be valid JSON"]);
});

test("parsing drops malformed entries and keeps folders inside the library", () => {
  const sets = parseCorrectionRuleSets(
    JSON.stringify([
      { id: "a", paths: ["/UniFi/", "../etc", "x/../y"], rules: [{ id: "r", find: "x" }, { find: "no id" }] },
      "junk",
    ]),
  );
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].paths, ["UniFi", "y"]);
  assert.equal(sets[0].rules.length, 1);
  assert.equal(sets[0].rules[0].caseSensitive, true);
  assert.equal(sets[0].rules[0].match, "word");
});

test("glossary terms are the plain rules' replacements, once each", () => {
  assert.deepEqual(correctionGlossaryTerms(compiled), ["Unifi", "Ubiquiti"]);
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
    const set: CorrectionRuleSet = { ...UBIQUITI, rules: [rule(find, replace, { match: "regex" })] };
    const rules = compileCorrectionsFor([set], "UniFi/a.srt", "source");
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
      JSON.stringify([{ ...UBIQUITI, rules: [rule("(?=Ubiq)", "X", { match: "regex" })] }]),
    ).join(),
    /empty text/,
  );
  const zero = { rule: rule("(?=Ubiq)", "X", { match: "regex" }), setName: "", pattern: /(?=Ubiq)/gu };
  assert.deepEqual(correctCueText("Ubiquity", [zero]), { text: "Ubiquity", counts: {} });
});

test("only name-like replacements are pinned in the glossary", () => {
  const set: CorrectionRuleSet = {
    ...UBIQUITI,
    rules: [rule("teh", "the"), rule("Ubiquity", "Ubiquiti"), rule("u7pro", "U7 Pro"), rule("優比快", "優比快")],
  };
  assert.deepEqual(correctionGlossaryTerms(compileCorrectionsFor([set], "UniFi/a", "source")), [
    "Ubiquiti",
    "U7 Pro",
    "優比快",
  ]);
});

test("lists that undo each other where both apply are refused on save", () => {
  const a: CorrectionRuleSet = { id: "a", name: "A", enabled: true, paths: ["TV"], rules: [rule("Unify", "UniFi")] };
  const b: CorrectionRuleSet = { id: "b", name: "B", enabled: true, paths: [""], rules: [rule("UniFi", "Unify")] };
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
      JSON.stringify([out("zh", "Unify", "UniFi", ["chi"]), out("ja", "UniFi", "Unify", ["jpn"])]),
    ),
    [],
  );
  assert.match(
    correctionRuleSetsErrors(
      JSON.stringify([out("zh", "Unify", "UniFi", ["chi"]), out("all", "UniFi", "Unify", [])]),
    ).join(),
    /undo each other/,
  );
});

test("a rule's exceptions skip exactly those files", () => {
  const set: CorrectionRuleSet = {
    ...UBIQUITI,
    rules: [rule("Ubiquity", "Ubiquiti", { except: ["UniFi/Essay.srt"] })],
  };
  assert.equal(compileCorrectionsFor([set], "UniFi/Essay.srt", "source").length, 0);
  assert.equal(compileCorrectionsFor([set], "UniFi/Talk.srt", "source").length, 1);
  const parsed = parseCorrectionRuleSets(
    JSON.stringify([{ ...set, rules: [{ ...set.rules[0], except: ["/UniFi/Essay.srt", "../x", "UniFi/Essay.srt"] }] }]),
  );
  assert.deepEqual(parsed[0].rules[0].except, ["UniFi/Essay.srt"]);
});

test("issues carry a code and what they are about, and still read in English", () => {
  const issues = correctionRuleSetsIssues(JSON.stringify([{ ...UBIQUITI, rules: [rule("UniFi", "UniFi Network")] }]));
  assert.deepEqual(issues, [{ code: "unstableSelf", find: "UniFi", list: "Ubiquiti" }]);
  assert.equal(
    describeCorrectionIssue(issues[0]),
    'Ubiquiti: "UniFi": The replacement would be changed again by this rule',
  );
});
