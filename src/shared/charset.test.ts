import test from "node:test";
import assert from "node:assert/strict";
import { decodeSubtitleBytes, decodeWindows1252, detectLegacyEncoding } from "./charset.js";
import { FIXTURES, bytesOf } from "./charset.fixtures.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

test("plain UTF-8 decodes unchanged, with or without its byte-order mark", () => {
  const body = "1\n00:00:01,000 --> 00:00:02,000\nCaf\u00e9 r\u00e9sum\u00e9 \u4e2d\u6587\n";
  assert.equal(decodeSubtitleBytes(utf8(body)), body);
  assert.equal(decodeSubtitleBytes(utf8(`\uFEFF${body}`)), body);
});

test("UTF-16 byte-order marks pick the encoding and are stripped", () => {
  for (const key of ["utf16le_bom", "utf16be_bom"]) {
    const fixture = FIXTURES[key];
    const decoded = decodeSubtitleBytes(bytesOf(fixture.hex));
    assert.equal(decoded, fixture.text, key);
    assert.ok(!decoded.includes("\uFEFF"));
  }
});

test("every legacy encoding in the fixture set is detected and decoded exactly", () => {
  const wrong: string[] = [];
  for (const [key, fixture] of Object.entries(FIXTURES)) {
    if (key.endsWith("_bom")) continue;
    const bytes = bytesOf(fixture.hex);
    const detected = detectLegacyEncoding(bytes);
    const decoded = decodeSubtitleBytes(bytes);
    if (decoded !== fixture.text) wrong.push(`${key}: ${fixture.encoding} read as ${detected}`);
  }
  assert.deepEqual(wrong, []);
});

test("invalid UTF-8 never throws and keeps the surrounding ASCII intact", () => {
  const decoded = decodeSubtitleBytes(new Uint8Array([0x31, 0x0a, 0xff, 0x0a]));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the class is "every non-ASCII byte", NUL included
  assert.equal(decoded.replace(/[^\x00-\x7f]/g, "?"), "1\n?\n");
  assert.equal(decodeSubtitleBytes(new Uint8Array(0)), "");
});

test("the windows-1252 family decodes the same way in every runtime", () => {
  // 0x97 is an em dash in windows-1252; Node's TextDecoder reads it as U+0097.
  const fixture = FIXTURES.client_emdash;
  assert.equal(decodeWindows1252(bytesOf(fixture.hex)), fixture.text);
  // A lone undefined byte keeps its C1 value instead of throwing.
  assert.equal(decodeWindows1252(Uint8Array.of(0x41, 0x81, 0x42)), "A\u0081B");
});
