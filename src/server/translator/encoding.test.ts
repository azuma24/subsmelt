import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES, bytesOf } from "../../shared/charset.fixtures.js";
import { readSubtitleFileText } from "./utils.js";

const SRT_BODY = `1
00:00:01,000 --> 00:00:04,000
Café résumé naïve
`;

function tmpFile(name: string, bytes: Uint8Array): string {
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
  assert.ok(!got.includes("\uFEFF"));
  assert.equal(got, SRT_BODY);
});

test("UTF-16 with a BOM, in either byte order, decodes to a clean string", () => {
  for (const key of ["utf16le_bom", "utf16be_bom"]) {
    const file = tmpFile(`${key}.srt`, bytesOf(FIXTURES[key].hex));
    const got = readSubtitleFileText(file);
    assert.ok(!got.includes("\uFEFF"));
    assert.equal(got, FIXTURES[key].text);
  }
});

test("legacy windows-1252 (latin1) accented SRT is detected and decoded", () => {
  const fixture = FIXTURES.server_windows1252;
  const got = readSubtitleFileText(tmpFile("latin1.srt", bytesOf(fixture.hex)));
  // The classic mojibake symptom (0xE0 decoded as utf8) would be U+FFFD.
  assert.ok(!got.includes("\uFFFD"), "should not contain replacement chars");
  assert.equal(got, fixture.text);
});

test("GBK-encoded CJK SRT is detected and decoded", () => {
  const fixture = FIXTURES.server_gbk;
  const got = readSubtitleFileText(tmpFile("gbk.srt", bytesOf(fixture.hex)));
  assert.ok(!got.includes("\uFFFD"));
  assert.equal(got, fixture.text);
});

test("never throws on a tiny/empty file, falls back to utf8", () => {
  const file = tmpFile("empty.srt", Buffer.alloc(0));
  assert.doesNotThrow(() => readSubtitleFileText(file));
  assert.equal(readSubtitleFileText(file), "");
});
