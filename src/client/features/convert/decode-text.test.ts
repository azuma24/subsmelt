import test from "node:test";
import assert from "node:assert/strict";
import { FIXTURES, bytesOf } from "../../../shared/charset.fixtures";
import { decodeSubtitleBytes, readSubtitleFile } from "./decode-text.js";

const HEADER = "1\n00:00:01,000 --> 00:00:02,000\n";

test("plain UTF-8 decodes unchanged", async () => {
  const body = `${HEADER}Café résumé\n`;
  assert.equal(await decodeSubtitleBytes(new TextEncoder().encode(body)), body);
});

test("Big5, Shift_JIS, GBK and windows-1252 drops are sniffed and decoded", async () => {
  for (const key of ["client_big5", "client_sjis", "client_gbk", "client_windows1252"]) {
    assert.equal(await decodeSubtitleBytes(bytesOf(FIXTURES[key].hex)), FIXTURES[key].text, key);
  }
});

test("readSubtitleFile decodes a Blob the way the drop zone hands it over", async () => {
  const fixture = FIXTURES.client_big5;
  assert.equal(await readSubtitleFile(new Blob([bytesOf(fixture.hex) as BlobPart])), fixture.text);
});
