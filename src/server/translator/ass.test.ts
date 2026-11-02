import test from "node:test";
import assert from "node:assert/strict";
import { parseAss, stringifyAss } from "./ass.js";

const ASS = [
  "[Script Info]",
  "; a comment",
  "Title: Sample: with a colon",
  "ScriptType: v4.00+",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize",
  "Style: Default,Arial,48",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello, world, with commas",
  "Comment: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,a comment line",
  "Dialogue: 0,0:00:05.50,0:00:08.00,Default,,0,0,0,,{\\an8}Second\\Nline",
  "",
  "[Aegisub Project Garbage]",
  "Last Style Storage: Default",
  "",
].join("\n");

test("sections, Format fields, mapped lines and comments round-trip unchanged", () => {
  const doc = parseAss(ASS);
  assert.deepEqual(
    doc.map((section) => section.section),
    ["Script Info", "V4+ Styles", "Events", "Aegisub Project Garbage"],
  );
  assert.deepEqual(doc[0].body[0], { key: ";", value: " a comment" });
  assert.deepEqual(doc[0].body[1], { key: "Title", value: "Sample: with a colon" });
  assert.deepEqual(doc[1].body[0], { key: "Format", value: ["Name", "Fontname", "Fontsize"] });
  assert.deepEqual(doc[1].body[1], { key: "Style", value: { Name: "Default", Fontname: "Arial", Fontsize: "48" } });
  const dialogue = doc[2].body[1];
  assert.equal(dialogue.key, "Dialogue");
  assert.equal((dialogue.value as Record<string, string>).Text, "Hello, world, with commas");
  assert.equal((doc[2].body[3].value as Record<string, string>).Text, "{\\an8}Second\\Nline");
  assert.equal(stringifyAss(doc), ASS);
});

test("CRLF, a BOM, text before the first section and a short Dialogue line are tolerated", () => {
  const doc = parseAss("﻿junk\r\n[Events]\r\nFormat: Layer, Start, Text\r\nDialogue: 0,0:00:01.00\r\n");
  assert.deepEqual(doc, [
    {
      section: "Events",
      body: [
        { key: "Format", value: ["Layer", "Start", "Text"] },
        { key: "Dialogue", value: { Layer: "0", Start: "0:00:01.00", Text: "" } },
      ],
    },
  ]);
  assert.equal(stringifyAss(doc), "[Events]\nFormat: Layer, Start, Text\nDialogue: 0,0:00:01.00,\n");
});

test("a section without lines stringifies as its header alone", () => {
  assert.equal(stringifyAss([{ section: "Fonts", body: [] }]), "[Fonts]\n");
});
