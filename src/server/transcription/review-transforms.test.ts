import assert from "node:assert/strict";
import test from "node:test";
import { transformReviewSubtitle } from "./review-transforms.js";

test("review adjustments preserve WebVTT blocks, cue IDs and settings", () => {
  const content = [
    "WEBVTT",
    "",
    "NOTE untouched",
    "00:01.000 --> 00:02.000",
    "",
    "STYLE",
    "::cue { color: white }",
    "",
    "caption-a",
    "00:01.000 --> 00:03.000 align:start",
    "alpha beta gamma delta",
  ].join("\r\n");
  const edited = transformReviewSubtitle(content, "vtt", [
    { kind: "offset", milliseconds: 1000 },
    { kind: "frameRate", from: 24, to: 48 },
    { kind: "balance", width: 12 },
  ]);
  assert.match(edited, /NOTE untouched\r\n00:01.000 --> 00:02.000/);
  assert.match(edited, /STYLE\r\n::cue \{ color: white \}/);
  assert.match(edited, /caption-a\r\n00:00:01.000 --> 00:00:02.000 align:start\r\nalpha beta\r\ngamma delta/);
});

test("ASS adjustment keeps styles and comments and rejects collapsed cues", () => {
  const content = [
    "[Script Info]",
    ";project comment",
    "Title: Original",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Text",
    "Dialogue: 0,0:00:01.00,0:00:02.00,Custom,{\\i1}Styled line",
  ].join("\n");
  const edited = transformReviewSubtitle(content, "ass", [
    { kind: "balance", width: 8 },
    { kind: "offset", milliseconds: 2000 },
  ]);
  assert.match(edited, /;project comment/);
  assert.match(edited, /Dialogue: 0,0:00:03.00,0:00:04.00,Custom,\{\\i1\}Styled line/);
  assert.throws(
    () => transformReviewSubtitle(content, "ass", [{ kind: "offset", milliseconds: -3000 }]),
    /collapses a cue/,
  );
});
