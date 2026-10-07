import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { buildZipBlob } from "./download-outputs.js";
import { buildZip, crc32 } from "./zip.js";

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}
function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** Walks the central directory the way an unzip tool does and returns each entry's name and inflated content. */
function readZip(bytes: Uint8Array): { name: string; content: string; method: number }[] {
  const end = bytes.length - 22;
  assert.equal(u32(bytes, end), 0x06054b50, "end of central directory");
  const count = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(u32(bytes, at), 0x02014b50, "central header");
    const method = u16(bytes, at + 10);
    const crc = u32(bytes, at + 16);
    const csize = u32(bytes, at + 20);
    const usize = u32(bytes, at + 24);
    const nameLen = u16(bytes, at + 28);
    const local = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    assert.equal(u32(bytes, local), 0x04034b50, "local header");
    const dataAt = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const payload = bytes.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? new Uint8Array(zlib.inflateRawSync(payload)) : payload;
    assert.equal(data.length, usize);
    assert.equal(crc32(data), crc);
    entries.push({ name, content: new TextDecoder().decode(data), method });
    at += 46 + nameLen;
  }
  return entries;
}

test("crc32 matches the reference value for a known string", () => {
  assert.equal(crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("entries come back out of the archive with their names and content, deflated when that is smaller", async () => {
  const long = `${"1\n00:00:01,000 --> 00:00:02,000\nHello world\n\n".repeat(40)}`;
  const blob = await buildZip([
    { name: "字幕.srt", content: long },
    { name: "tiny.vtt", content: "WEBVTT\n" },
    { name: "empty.srt", content: "" },
  ]);
  assert.equal(blob.type, "application/zip");
  const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.content]),
    [
      ["字幕.srt", long],
      ["tiny.vtt", "WEBVTT\n"],
      ["empty.srt", ""],
    ],
  );
  assert.equal(entries[0].method, 8, "a repetitive file is deflated");
  assert.equal(entries[2].method, 0, "an empty file is stored");
});

test("the download gives files that share a name a numbered suffix instead of overwriting", async () => {
  const blob = await buildZipBlob([
    { name: "Show.srt", content: "a" },
    { name: "Show.srt", content: "b" },
    { name: "Show.srt", content: "c" },
    { name: "README", content: "d" },
    { name: "README", content: "e" },
  ]);
  const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["Show.srt", "Show(1).srt", "Show(2).srt", "README", "README(1)"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.content),
    ["a", "b", "c", "d", "e"],
  );
});
