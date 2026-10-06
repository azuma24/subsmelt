import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleCueText } from "./cue-sample";

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there.

2
00:00:04,000 --> 00:00:06,000
<i>General Kenobi!</i>
Second line.
`;

test("SRT: skips indices and timestamps, strips inline tags, joins cue text", () => {
  const text = sampleCueText(SRT);
  assert.ok(text.includes("Hello there."));
  assert.ok(text.includes("General Kenobi!"));
  assert.ok(text.includes("Second line."));
  assert.ok(!text.includes("-->"));
  assert.ok(!/^\d+$/m.test(text));
  assert.ok(!text.includes("<i>"));
});

const VTT = `WEBVTT

NOTE a comment

00:01.000 --> 00:04.000 position:10%
- <v Roger>Where are we now?</v>

00:05.000 --> 00:09.000
- This is big <b>bold</b> claim.
`;

test("VTT: skips header, NOTE blocks, cue settings; strips voice/format tags", () => {
  const text = sampleCueText(VTT);
  assert.ok(text.includes("Where are we now?"));
  assert.ok(text.includes("This is big bold claim."));
  assert.ok(!text.includes("WEBVTT"));
  assert.ok(!text.includes("position"));
  assert.ok(!text.includes("<v"));
});

const ASS = `[Script Info]
Title: test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}こんにちは{\\i0}\\N世界
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,これは字幕です
Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,ignore me
`;

test("ASS: only Dialogue text, override tags and \\N stripped, Comment lines ignored", () => {
  const text = sampleCueText(ASS);
  assert.ok(text.includes("こんにちは"));
  assert.ok(text.includes("世界"));
  assert.ok(text.includes("これは字幕です"));
  assert.ok(!text.includes("{\\i1}"));
  assert.ok(!text.includes("ignore me"));
  assert.ok(!text.includes("Script Info"));
});

test("caps at maxCues cues", () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    `${i + 1}\n00:00:0${i % 9},000 --> 00:00:0${(i % 9) + 1},000\ncue number ${i}\n`,
  ).join("\n");
  const text = sampleCueText(many, 30);
  assert.ok(text.includes("cue number 29"));
  assert.ok(!text.includes("cue number 30"));
});
