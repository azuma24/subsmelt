import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clock, groupParagraphs, noteFileName, paragraphStarts, renderNote, safeNoteName, type Cue, type NoteInfo } from "./note.js";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "testdata", "note.golden.md");

const cue = (start: number, end: number, text: string): Cue => ({ start, end, text });

const info: NoteInfo = {
  videoId: "dQw4w9WgXcQ",
  title: 'Why the Roman Empire fell: "money" #1',
  channel: "History | Channel [HD]",
  published: "2026-08-14",
  added: null,
  durationS: 2530,
  playlist: "Learning",
  language: "en",
  transcriptSource: "youtube_captions",
  description: "Why did Rome fall?\n\nSources: https://example.com/rome",
  chapters: [
    { start: 0, title: "Intro" },
    { start: 60, title: "The army" },
  ],
};

const english = [
  cue(0, 4, "Welcome back to the channel."),
  cue(4, 9, "Today we look at why\nthe Roman Empire fell."),
  cue(9, 20, "It is a long story,"),
  cue(20, 47, "and it starts with money."),
  cue(47, 52, "Rome paid its soldiers in silver."),
  cue(52, 58, "Over time the coins held less of it"),
  cue(61, 70, "<i>The army</i> grew"),
  cue(70, 100, "and grew"),
  cue(100, 165, "and kept on growing"),
  cue(165, 170, "The end."),
];

const chinese = [
  cue(0, 4, "歡迎回到頻道。"),
  cue(4, 9, "今天我們來看羅馬帝國為何衰亡。"),
  cue(9, 20, "說來話長，"),
  cue(20, 47, "一切從錢開始。"),
  cue(47, 52, "羅馬用銀幣支付軍餉。"),
  cue(52, 58, "銀的含量越來越少"),
  cue(61, 70, "軍隊不斷擴大"),
  cue(70, 100, "再擴大"),
  cue(100, 165, "一直擴大"),
  cue(165, 170, "完。"),
];

test("renderNote matches the golden note with an English transcript and a Traditional Chinese section", () => {
  const note = renderNote(info, english, [{ label: "繁體中文", langCode: "zh-TW", cues: chinese }]);
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, note);
  assert.equal(note, fs.readFileSync(GOLDEN, "utf8"));
});

test("paragraphs break at a sentence end after 45 s, at a chapter start, and after 90 s without punctuation", () => {
  assert.deepEqual(paragraphStarts(english, info.chapters), [0, 47, 61, 165]);
});

test("a sentence end before 45 s does not break the paragraph", () => {
  const cues = [cue(0, 10, "One."), cue(10, 20, "Two."), cue(20, 50, "Three."), cue(50, 55, "Four.")];
  assert.deepEqual(paragraphStarts(cues, []), [0, 50]);
});

test("a chapter start breaks the paragraph even mid-sentence", () => {
  const cues = [cue(0, 5, "we start"), cue(5, 12, "and then"), cue(12, 20, "carry on")];
  assert.deepEqual(paragraphStarts(cues, [{ start: 0, title: "A" }, { start: 10, title: "B" }]), [0, 12]);
});

test("a translation with its own timing breaks at the first cue past each source paragraph start", () => {
  const cues = [cue(0, 30, "一。"), cue(30, 49, "二。"), cue(49, 60, "三。")];
  assert.deepEqual(groupParagraphs(cues, [0, 47]), [
    { start: 0, text: "一。二。" },
    { start: 49, text: "三。" },
  ]);
});

test("cue text loses markup and joins CJK without spaces but Latin with one", () => {
  const cues = [cue(0, 1, "{\\an8}<b>Hello</b>"), cue(1, 2, "world"), cue(2, 3, "你好"), cue(3, 4, "世界")];
  assert.deepEqual(groupParagraphs(cues, [0]), [{ start: 0, text: "Hello world 你好世界" }]);
});

test("note file names drop characters that break Obsidian links or paths", () => {
  assert.equal(noteFileName("Why the Roman Empire fell", "dQw4w9WgXcQ"), "Why the Roman Empire fell (dQw4w9WgXcQ).md");
  assert.equal(noteFileName("[Live] Q&A #3 ^ top | best", "dQw4w9WgXcQ"), "Live Q&A 3 top best (dQw4w9WgXcQ).md");
  assert.equal(noteFileName("AC/DC: back\\in \"black\"?", "dQw4w9WgXcQ"), "AC DC back in black (dQw4w9WgXcQ).md");
  assert.equal(noteFileName("...hidden.", "dQw4w9WgXcQ"), "hidden (dQw4w9WgXcQ).md");
  assert.equal(noteFileName("[#|]", "dQw4w9WgXcQ"), "dQw4w9WgXcQ.md");
  assert.equal(noteFileName("羅馬帝國為何衰亡", "dQw4w9WgXcQ"), "羅馬帝國為何衰亡 (dQw4w9WgXcQ).md");
});

test("a long title is cut on a character boundary to stay within 255 bytes", () => {
  const name = noteFileName("羅".repeat(100), "dQw4w9WgXcQ");
  assert.equal(name, `${"羅".repeat(60)} (dQw4w9WgXcQ).md`);
  assert.ok(Buffer.byteLength(name) <= 255);
});

test("wikilink names get the same treatment", () => {
  assert.equal(safeNoteName("History | Channel [HD]"), "History Channel HD");
});

test("clock shows hours only when there are some", () => {
  assert.equal(clock(0), "00:00");
  assert.equal(clock(83.9), "01:23");
  assert.equal(clock(2530), "42:10");
  assert.equal(clock(3723), "1:02:03");
});

test("a hash at the start of a word is escaped so Obsidian does not read a tag", () => {
  assert.deepEqual(groupParagraphs([cue(0, 1, "learn #python today, issue#3")], [0]), [{ start: 0, text: "learn \\#python today, issue#3" }]);
});
