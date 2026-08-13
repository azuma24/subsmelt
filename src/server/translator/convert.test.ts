import test from "node:test";
import assert from "node:assert/strict";
import { convertSubtitle } from "./utils.js";

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:08,000
Second line
with a break
`;

test("srt → vtt preserves cue count and original text", () => {
  const out = convertSubtitle(SRT, "srt", "vtt");
  assert.match(out, /^WEBVTT/);
  assert.match(out, /Hello world/);
  assert.match(out, /Second line/);
  assert.match(out, /with a break/);
  // VTT uses '.' as the millisecond separator.
  assert.match(out, /00:00:01\.000 --> 00:00:04\.000/);
  // Two cue timing arrows.
  assert.equal((out.match(/-->/g) || []).length, 2);
});

test("srt → ass preserves cue count and original text", () => {
  const out = convertSubtitle(SRT, "srt", "ass");
  assert.match(out, /\[Script Info\]/);
  assert.match(out, /\[Events\]/);
  const dialogues = out.match(/^Dialogue:/gm) || [];
  assert.equal(dialogues.length, 2);
  assert.match(out, /Hello world/);
  // Newlines within a cue become the ASS hard-break token.
  assert.match(out, /Second line\\NWith a break/i);
});

test("vtt → srt round-trips back to srt cue count and text", () => {
  const vtt = convertSubtitle(SRT, "srt", "vtt");
  const srt = convertSubtitle(vtt, "vtt", "srt");
  assert.match(srt, /Hello world/);
  assert.match(srt, /Second line/);
  // SRT uses ',' as the millisecond separator and numbered cues.
  assert.match(srt, /00:00:01,000 --> 00:00:04,000/);
  assert.equal((srt.match(/-->/g) || []).length, 2);
});

test("rejects unsupported source/target extensions", () => {
  assert.throws(() => convertSubtitle(SRT, "txt", "srt"), /Unsupported source extension/);
  assert.throws(() => convertSubtitle(SRT, "srt", "txt"), /Unsupported target extension/);
});

test("throws a clear error on empty input", () => {
  assert.throws(() => convertSubtitle("", "srt", "vtt"), /empty/i);
});

test("throws on unparseable input with no cues", () => {
  assert.throws(() => convertSubtitle("not a subtitle at all", "srt", "vtt"), /no subtitle cues|failed to parse/i);
});
