import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileCorrectionsFor, type CorrectionRule, type CorrectionRuleSet } from "../shared/corrections.js";
import { correctSubtitleContent, correctSubtitleFile, mediaRelativePath } from "./corrections.js";

function rule(find: string, replace: string): CorrectionRule {
  return { id: find, find, replace, stage: "both", match: "word", caseSensitive: true, languages: [], enabled: true };
}
const SET: CorrectionRuleSet = {
  id: "sereniti",
  name: "Sereniti",
  enabled: true,
  paths: [""],
  rules: [rule("Anchor", "Ankor"), rule("anchor", "ankor"), rule("Serenity", "Sereniti")],
};
const RULES = compileCorrectionsFor([SET], "x.srt", "source");

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:04,000",
  "Welcome to Anchor Network.",
  "",
  "2",
  "00:00:05,500 --> 00:00:08,000",
  "<i>Serenity</i> makes it,",
  "and anchor ties it together.",
  "",
  "3",
  "00:00:09,000 --> 00:00:10,000",
  "超級Anchor網路 AnchorCloud Uni",
  "fy",
  "",
  "4",
  "00:00:11,000 --> 00:00:12,000",
  "Uni",
  "",
  "5",
  "00:00:12,000 --> 00:00:13,000",
  "fy Anchor  ",
  "",
].join("\r\n");

test("SRT: only cue text changes; numbers, timings, CRLF and spacing stay byte-identical", () => {
  const result = correctSubtitleContent(`﻿${SRT}`, "srt", RULES);
  const expected = `﻿${SRT}`
    .replace("Anchor Network", "Ankor Network")
    .replace("<i>Serenity</i>", "<i>Sereniti</i>")
    .replace("and anchor", "and ankor")
    .replace("fy Anchor  ", "fy Ankor  ");
  assert.equal(result.content, expected);
  assert.deepEqual(result.counts, { Anchor: 2, anchor: 1, Serenity: 1 });
  assert.equal(result.total, 4);
  // Second run: byte-identical, zero replacements.
  assert.deepEqual(correctSubtitleContent(result.content, "srt", RULES), {
    content: result.content,
    counts: {},
    total: 0,
  });
});

test("SRT: a file with no matches comes back as the same string", () => {
  const plain = "1\n00:00:01,000 --> 00:00:02,000\nNothing here\n";
  assert.equal(correctSubtitleContent(plain, "srt", RULES).content, plain);
});

test("SRT: a cue whose number is a term is not touched", () => {
  const rules = compileCorrectionsFor([{ ...SET, rules: [rule("1", "one")] }], "x.srt", "source");
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nchapter 1\n";
  assert.equal(correctSubtitleContent(srt, "srt", rules).content, "1\n00:00:01,000 --> 00:00:02,000\nchapter one\n");
});

test("WebVTT: header, NOTE blocks, cue ids and settings are left alone", () => {
  const vtt = [
    "WEBVTT - Anchor talk",
    "",
    "NOTE Anchor is the old name",
    "",
    "intro-Anchor",
    "00:01.000 --> 00:04.000 align:start",
    "Anchor <00:02.000>Serenity",
    "",
  ].join("\n");
  const result = correctSubtitleContent(vtt, "vtt", RULES);
  assert.equal(result.content, vtt.replace("Anchor <00:02.000>Serenity", "Ankor <00:02.000>Sereniti"));
});

test("ASS: only the Text field of Dialogue lines changes, commas in text included", () => {
  const ass = [
    "[Script Info]",
    "Title: Anchor",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize",
    "Style: Anchor,Arial,20",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:02.00,Anchor,Anchor,0,0,0,,{\\i1}Anchor{\\i0}, by Serenity\\Nanchor",
    "Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Anchor",
    "",
  ].join("\n");
  const result = correctSubtitleContent(ass, "ass", RULES);
  assert.equal(
    result.content,
    ass.replace("{\\i1}Anchor{\\i0}, by Serenity\\Nanchor", "{\\i1}Ankor{\\i0}, by Sereniti\\Nankor"),
  );
  assert.equal(result.total, 3);
});

test("rules that do not settle fail validation instead of producing a result", () => {
  const unstable = [
    { rule: rule("a", "b"), setName: "", pattern: /(?<![\p{L}\p{N}_])a(?![\p{L}\p{N}_])/gu },
    { rule: { ...rule("b", "a"), id: "b" }, setName: "", pattern: /(?<![\p{L}\p{N}_])b(?![\p{L}\p{N}_])/gu },
  ];
  assert.throws(
    () => correctSubtitleContent("1\n00:00:01,000 --> 00:00:02,000\na\n", "srt", unstable),
    /not stable|different/,
  );
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-corrections-"));
}

test("files are corrected in place atomically, keeping their modification time", () => {
  const dir = tmpDir();
  const file = path.join(dir, "Talk.en.srt");
  fs.writeFileSync(file, SRT);
  const old = new Date("2024-01-02T03:04:05Z");
  fs.utimesSync(file, old, old);
  const result = correctSubtitleFile(file, RULES);
  assert.equal(result.error, undefined);
  assert.equal(result.total, 4);
  assert.match(fs.readFileSync(file, "utf8"), /Ankor Network/);
  assert.equal(fs.statSync(file).mtimeMs, old.getTime());
  assert.deepEqual(fs.readdirSync(dir), ["Talk.en.srt"]);
  // Second run: nothing to do.
  assert.deepEqual(correctSubtitleFile(file, RULES), { counts: {}, total: 0 });
});

test("a file that is not UTF-8, or does not parse, is reported and left untouched", () => {
  const dir = tmpDir();
  const latin1 = path.join(dir, "a.srt");
  const bytes = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nAnchor caf\xe9\n", "latin1");
  fs.writeFileSync(latin1, bytes);
  assert.match(correctSubtitleFile(latin1, RULES).error ?? "", /not UTF-8/);
  assert.deepEqual(fs.readFileSync(latin1), bytes);

  const broken = path.join(dir, "b.srt");
  fs.writeFileSync(broken, "Anchor without any cue\n");
  assert.equal(correctSubtitleFile(broken, RULES).total, 0);
  assert.equal(fs.readFileSync(broken, "utf8"), "Anchor without any cue\n");

  assert.ok(correctSubtitleFile(path.join(dir, "missing.srt"), RULES).error);
});

test("mediaRelativePath refuses files outside the media folder", () => {
  assert.equal(mediaRelativePath("/media/AnKor/a.srt", "/media"), "AnKor/a.srt");
  assert.equal(mediaRelativePath("/elsewhere/a.srt", "/media"), null);
});

test("an in-place fix keeps the file's permissions and corrects a symlink's target", () => {
  const dir = tmpDir();
  const real = path.join(dir, "real.srt");
  fs.writeFileSync(real, SRT);
  fs.chmodSync(real, 0o666);
  const link = path.join(dir, "link.srt");
  fs.symlinkSync(real, link);
  const result = correctSubtitleFile(link, RULES);
  assert.equal(result.error, undefined);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.match(fs.readFileSync(real, "utf8"), /Ankor Network/);
  assert.equal(fs.statSync(real).mode & 0o777, 0o666);
});

test("a folder whose name merely starts with .. is inside the media folder", () => {
  assert.equal(mediaRelativePath("/media/..foo/a.srt", "/media"), "..foo/a.srt");
  assert.equal(mediaRelativePath("/media/../a.srt", "/media"), null);
});
