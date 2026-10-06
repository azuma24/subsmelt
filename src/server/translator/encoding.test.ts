import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { readSubtitleFileText } from "./utils.js";

const SRT_BODY = `1
00:00:01,000 --> 00:00:04,000
Café résumé naïve
`;

function tmpFile(name: string, bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-enc-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

test("plain UTF-8 decodes identically to a utf8 readFileSync (no behavior change)", () => {
  const file = tmpFile("plain.srt", Buffer.from(SRT_BODY, "utf8"));
  const got = readSubtitleFileText(file);
  assert.equal(got, fs.readFileSync(file, "utf8"));
  assert.equal(got, SRT_BODY);
});

test("UTF-8 BOM is stripped, accented chars intact", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const file = tmpFile("bom-utf8.srt", Buffer.concat([bom, Buffer.from(SRT_BODY, "utf8")]));
  const got = readSubtitleFileText(file);
  // No leading BOM character (U+FEFF).
  assert.equal(got.charCodeAt(0), "1".charCodeAt(0));
  assert.ok(!got.includes("﻿"));
  assert.ok(got.includes("Café résumé naïve"));
  assert.equal(got, SRT_BODY);
});

test("UTF-16 LE with BOM decodes to clean string", () => {
  const file = tmpFile("utf16le.srt", iconv.encode(SRT_BODY, "utf-16le", { addBOM: true }));
  const got = readSubtitleFileText(file);
  assert.ok(!got.includes("﻿"));
  assert.ok(got.includes("Café résumé naïve"));
});

test("UTF-16 BE with BOM decodes to clean string", () => {
  const file = tmpFile("utf16be.srt", iconv.encode(SRT_BODY, "utf-16be", { addBOM: true }));
  const got = readSubtitleFileText(file);
  assert.ok(!got.includes("﻿"));
  assert.ok(got.includes("Café résumé naïve"));
});

test("legacy windows-1252 (latin1) accented SRT is detected and decoded", () => {
  // A line of clearly non-ASCII Latin text in a single-byte legacy encoding.
  const legacyBody = `1
00:00:01,000 --> 00:00:04,000
Voilà, déjà vu — naïve garçon café résumé
Une journée à Montréal, très élégante époque
`;
  const file = tmpFile("latin1.srt", iconv.encode(legacyBody, "windows-1252"));
  const got = readSubtitleFileText(file);
  // The classic mojibake symptom (0xE0 decoded as utf8) would be U+FFFD.
  assert.ok(!got.includes("�"), "should not contain replacement chars");
  assert.ok(got.includes("Voilà"));
  assert.ok(got.includes("garçon café résumé"));
  assert.ok(got.includes("Montréal"));
});

test("GBK-encoded CJK SRT is detected and decoded", () => {
  const cjkBody = `1
00:00:01,000 --> 00:00:04,000
你好世界，这是一个测试字幕文件
我们正在翻译中文字幕的内容
`;
  const file = tmpFile("gbk.srt", iconv.encode(cjkBody, "gbk"));
  const got = readSubtitleFileText(file);
  assert.ok(!got.includes("�"));
  assert.ok(got.includes("你好世界"));
  assert.ok(got.includes("翻译中文字幕"));
});

test("never throws on a tiny/empty file, falls back to utf8", () => {
  const file = tmpFile("empty.srt", Buffer.alloc(0));
  assert.doesNotThrow(() => readSubtitleFileText(file));
  assert.equal(readSubtitleFileText(file), "");
});
