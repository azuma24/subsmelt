import assert from "node:assert/strict";
import test from "node:test";
import { inspectSubtitle } from "./subtitle-quality.js";

test("reports malformed timing separately from a valid zero start and finds nested overlaps", () => {
  const { issues } = inspectSubtitle(
    "1\n00:00:00,000 --> 00:00:04,000\nFirst\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond\n\n" +
      "3\n00:00:02,500 --> 00:00:03,000\nThird\n\n4\n00:00:x,000 --> 00:00:05,000\nMalformed\n",
    "srt",
  );
  assert.deepEqual(
    issues.filter((issue) => issue.code === "invalidTiming"),
    [{ code: "invalidTiming", line: 14 }],
  );
  assert.deepEqual(
    issues.filter((issue) => issue.code === "overlap").map((issue) => issue.cue),
    [2, 3],
  );
});

test("measures visible graphemes in WebVTT independently of CJK line width", () => {
  const { issues } = inspectSubtitle(
    "WEBVTT\n\n00:00.000 --> 00:02.000\n<c.label>" + "字".repeat(22) + "</c>\n",
    "vtt",
  );
  assert.deepEqual(issues, [
    { cue: 1, code: "width", value: 44, limit: 42 },
    { cue: 1, code: "speed", value: 11, limit: 9 },
  ]);
});

test("ignores overlap between ASS layers and separates visual breaks from override tags", () => {
  const { issues } = inspectSubtitle(
    "[Events]\nFormat: Layer, Start, End, Text\n" +
      "Dialogue: 0,0:00:00.00,0:00:02.00,{\\i1}A\\NB\\NC\n" +
      "Dialogue: 1,0:00:00.00,0:00:02.00,Overlay\n",
    "ass",
  );
  assert.deepEqual(issues, [{ cue: 1, code: "lines", value: 3, limit: 2 }]);
});
