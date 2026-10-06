import test from "node:test";
import assert from "node:assert/strict";
import iconv from "iconv-lite";
import { decodeSubtitleBytes, decodeWindows1252, readSubtitleFile } from "./decode-text.js";

const HEADER = "1\n00:00:01,000 --> 00:00:02,000\n";
const bytes = (text: string, encoding: string, addBOM = false): Uint8Array =>
  new Uint8Array(iconv.encode(text, encoding, { addBOM }));

test("plain UTF-8 decodes unchanged", () => {
  assert.equal(decodeSubtitleBytes(bytes(`${HEADER}Café résumé\n`, "utf8")), `${HEADER}Café résumé\n`);
});

test("byte-order marks pick the encoding and are stripped", () => {
  const body = `${HEADER}Voilà\n`;
  assert.equal(decodeSubtitleBytes(bytes(body, "utf8", true)), body);
  assert.equal(decodeSubtitleBytes(bytes(body, "utf-16le", true)), body);
  assert.equal(decodeSubtitleBytes(bytes(body, "utf-16be", true)), body);
});

test("Big5 is sniffed and decoded instead of becoming replacement characters", () => {
  const body = `${HEADER}中文字幕測試，這是一個繁體中文的檔案\n我們正在翻譯字幕的內容\n`;
  assert.equal(decodeSubtitleBytes(bytes(body, "big5")), body);
});

test("Shift_JIS is sniffed and decoded", () => {
  const body = `${HEADER}こんにちは、これは日本語の字幕ファイルです\n字幕の内容を翻訳しています\n`;
  assert.equal(decodeSubtitleBytes(bytes(body, "shift_jis")), body);
});

test("GBK is sniffed and decoded", () => {
  const body = `${HEADER}你好世界，这是一个测试字幕文件\n我们正在翻译中文字幕的内容\n`;
  assert.equal(decodeSubtitleBytes(bytes(body, "gbk")), body);
});

test("Windows-1252 accented Latin text is sniffed and decoded", () => {
  const body = `${HEADER}Voilà, déjà vu — naïve garçon café résumé\nUne journée à Montréal, très élégante époque\n`;
  assert.equal(decodeSubtitleBytes(bytes(body, "windows-1252")), body);
});

test("invalid UTF-8 never throws and keeps the surrounding ASCII intact", () => {
  const decoded = decodeSubtitleBytes(new Uint8Array([0x31, 0x0a, 0xff, 0x0a]));
  assert.equal(decoded.replace(/[^\x00-\x7f]/g, "?"), "1\n?\n");
});

test("readSubtitleFile decodes a Blob the way the drop zone hands it over", async () => {
  const body = `${HEADER}中文字幕測試，這是一個繁體中文的檔案\n我們正在翻譯字幕的內容\n`;
  assert.equal(await readSubtitleFile(new Blob([bytes(body, "big5") as BlobPart])), body);
});

test("the windows-1252 family decodes the same way in every runtime", () => {
  // 0x97 is an em dash in windows-1252; Node's TextDecoder reads it as U+0097.
  const body = `${HEADER}Voilà — café\n`;
  const encoded = bytes(body, "windows-1252");
  assert.equal(decodeWindows1252(encoded), body);
  assert.equal(decodeSubtitleBytes(encoded), body);
  // A lone undefined byte keeps its C1 value instead of throwing.
  assert.equal(decodeWindows1252(Uint8Array.of(0x41, 0x81, 0x42)), "A\u0081B");
});
