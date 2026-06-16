import test from "node:test";
import assert from "node:assert/strict";
import { applyCueEdits, parseSubtitle } from "./utils.js";

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:08,000
Second line
with a break
`;

const ASS = `[Script Info]
Title: Sample
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,48

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:05.50,0:00:08.00,Default,,0,0,0,,Second line
`;

test("applyCueEdits: srt edit rewrites the targeted cue text only", () => {
  const { output, updated } = applyCueEdits(SRT, "srt", [{ index: 2, text: "Edited line" }]);
  assert.equal(updated, 1);

  const parsed = parseSubtitle(output, "srt") as any[];
  const cues = parsed.filter((n) => n.type === "cue");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].data.text, "Hello world");
  assert.equal(cues[1].data.text, "Edited line");
  // Timing must be preserved.
  assert.match(output, /00:00:05,500 --> 00:00:08,000/);
});

test("applyCueEdits: srt round-trips multiple edits by 1-based index", () => {
  const { output, updated } = applyCueEdits(SRT, "srt", [
    { index: 1, text: "First!" },
    { index: 2, text: "Second!" },
  ]);
  assert.equal(updated, 2);
  const cues = (parseSubtitle(output, "srt") as any[]).filter((n) => n.type === "cue");
  assert.equal(cues[0].data.text, "First!");
  assert.equal(cues[1].data.text, "Second!");
});

test("applyCueEdits: out-of-range indices are skipped and not counted", () => {
  const { output, updated } = applyCueEdits(SRT, "srt", [
    { index: 99, text: "ignored" },
    { index: 0, text: "ignored too" },
    { index: 1, text: "kept" },
  ]);
  assert.equal(updated, 1);
  const cues = (parseSubtitle(output, "srt") as any[]).filter((n) => n.type === "cue");
  assert.equal(cues[0].data.text, "kept");
  assert.equal(cues[1].data.text, "Second line\nwith a break");
});

test("applyCueEdits: ass edits only Dialogue text and preserves document/styles", () => {
  const { output, updated } = applyCueEdits(ASS, "ass", [{ index: 1, text: "Bonjour" }]);
  assert.equal(updated, 1);
  // Script Info and Styles preserved.
  assert.match(output, /\[Script Info\]/);
  assert.match(output, /\[V4\+ Styles\]/);
  assert.match(output, /Style: Default/);
  // First dialogue rewritten, second untouched.
  assert.match(output, /Dialogue:[^\n]*Bonjour/);
  assert.match(output, /Dialogue:[^\n]*Second line/);
});

test("applyCueEdits: ass newlines in edited text become hard-break tokens", () => {
  const { output } = applyCueEdits(ASS, "ass", [{ index: 2, text: "Line A\nLine B" }]);
  assert.match(output, /Dialogue:[^\n]*Line A\\NLine B/);
});
