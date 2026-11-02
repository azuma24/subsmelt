import test from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, parseSrtVtt, parseTimestamp, stringifySubtitle } from "./srt-vtt.js";

const SRT =
  "1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:00:05,500 --> 00:00:08,000\nSecond line\nwith a break\n";

test("srt parses to numbered cues in milliseconds and stringifies back byte for byte", () => {
  const nodes = parseSrtVtt(SRT);
  assert.deepEqual(nodes, [
    { type: "cue", data: { start: 1000, end: 4000, text: "Hello world" } },
    { type: "cue", data: { start: 5500, end: 8000, text: "Second line\nwith a break" } },
  ]);
  assert.equal(stringifySubtitle(nodes, "SRT"), SRT);
});

test("srt to vtt adds the header and switches the millisecond separator", () => {
  assert.equal(
    stringifySubtitle(parseSrtVtt(SRT), "WebVTT"),
    "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHello world\n\n2\n00:00:05.500 --> 00:00:08.000\nSecond line\nwith a break\n",
  );
});

test("vtt keeps its header block and cue settings, and skips NOTE, STYLE, REGION and identifiers", () => {
  const vtt = [
    "WEBVTT - Example",
    "Kind: captions",
    "",
    "STYLE",
    "::cue { color: yellow }",
    "",
    "REGION",
    "id:bottom",
    "width:40%",
    "",
    "NOTE check the names",
    "",
    "intro",
    "00:00:01.000 --> 00:00:02.000 align:start position:10%",
    "Hello",
    "",
    "2",
    "00:00:03.000 --> 00:00:04.500",
    "Second line",
    "with a break",
    "",
    "NOTE a note between cues",
    "",
    "00:00:05.000 --> 00:00:06.000",
    "Bye",
    "",
  ].join("\r\n");
  const nodes = parseSrtVtt(vtt);
  assert.deepEqual(nodes, [
    { type: "header", data: "WEBVTT - Example\nKind: captions" },
    { type: "cue", data: { start: 1000, end: 2000, text: "Hello", settings: "align:start position:10%" } },
    { type: "cue", data: { start: 3000, end: 4500, text: "Second line\nwith a break" } },
    { type: "cue", data: { start: 5000, end: 6000, text: "Bye" } },
  ]);
  assert.equal(
    stringifySubtitle(nodes, "WebVTT"),
    "WEBVTT - Example\nKind: captions\n\n1\n00:00:01.000 --> 00:00:02.000 align:start position:10%\nHello\n\n2\n00:00:03.000 --> 00:00:04.500\nSecond line\nwith a break\n\n3\n00:00:05.000 --> 00:00:06.000\nBye\n",
  );
  // SRT output drops the header and the settings.
  assert.equal(
    stringifySubtitle(nodes, "SRT"),
    "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,500\nSecond line\nwith a break\n\n3\n00:00:05,000 --> 00:00:06,000\nBye\n",
  );
});

test("a blank line inside a cue stays in its text; the next cue's index is not", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nFirst\n\nstill first\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n";
  assert.deepEqual(
    parseSrtVtt(srt).map((node) => node.type === "cue" && node.data.text),
    ["First\n\nstill first", "Second"],
  );
});

test("a BOM, a timing line without an index, an empty cue and junk lines are all tolerated", () => {
  const srt =
    "﻿00:00:01,000 --> 00:00:02,000\nA\n\nnot a cue\nat all\n\n2\n00:00:03,000 --> 00:00:04,000\n\n3\n01:02:03,004 --> 01:02:05,006\nC\n";
  assert.deepEqual(parseSrtVtt(srt), [
    { type: "cue", data: { start: 1000, end: 2000, text: "A\n\nnot a cue\nat all" } },
    { type: "cue", data: { start: 3000, end: 4000, text: "" } },
    { type: "cue", data: { start: 3_723_004, end: 3_725_006, text: "C" } },
  ]);
  assert.deepEqual(parseSrtVtt("not a subtitle at all"), []);
  assert.deepEqual(parseSrtVtt(""), []);
});

test("timestamps accept short forms and format past 99 hours", () => {
  assert.equal(parseTimestamp("01:02.5"), 62_500);
  assert.equal(parseTimestamp("1:02:03,45"), 3_723_450);
  assert.throws(() => parseTimestamp("nope"), /Invalid SRT or VTT time format/);
  assert.equal(formatTimestamp(360_000_000), "100:00:00,000");
  assert.equal(formatTimestamp(-5, "WebVTT"), "00:00:00.000");
  assert.equal(formatTimestamp(Number.NaN), "00:00:00,000");
});

test("stringify takes cue-like objects with string times, as the translator builds them", () => {
  const out = stringifySubtitle(
    [{ type: "cue", data: { start: "00:00:01,000", end: "00:00:02,000", text: "x" } }],
    "SRT",
  );
  assert.equal(out, "1\n00:00:01,000 --> 00:00:02,000\nx\n");
});
