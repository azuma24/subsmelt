/**
 * A ZIP writer for the converter's "download all" button: a handful of small
 * text files, deflated through the browser's CompressionStream when it has
 * one and stored as they are otherwise. Names are UTF-8 (the flag bit says
 * so), so a subtitle called 字幕.srt keeps its name on every platform.
 */

export interface ZipEntry {
  name: string;
  content: string | Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date words, as the ZIP format stores them (two-second resolution, 1980-based). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== "function") return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

class ByteWriter {
  private readonly parts: Uint8Array[] = [];
  length = 0;

  bytes(part: Uint8Array): void {
    this.parts.push(part);
    this.length += part.length;
  }

  u16(value: number): void {
    this.bytes(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff));
  }

  u32(value: number): void {
    this.bytes(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));
  }

  toBlob(type: string): Blob {
    return new Blob(this.parts as BlobPart[], { type });
  }
}

const UTF8_NAMES = 0x0800;
const VERSION = 20;

/** The entries as one ZIP archive. */
export async function buildZip(entries: ZipEntry[], now = new Date()): Promise<Blob> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const out = new ByteWriter();
  const central = new ByteWriter();
  let count = 0;

  for (const entry of entries) {
    const data = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const name = encoder.encode(entry.name);
    const deflated = data.length > 0 ? await deflateRaw(data) : null;
    const stored = deflated === null || deflated.length >= data.length;
    const payload = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    const offset = out.length;

    out.u32(0x04034b50);
    out.u16(VERSION);
    out.u16(UTF8_NAMES);
    out.u16(method);
    out.u16(time);
    out.u16(date);
    out.u32(crc);
    out.u32(payload.length);
    out.u32(data.length);
    out.u16(name.length);
    out.u16(0);
    out.bytes(name);
    out.bytes(payload);

    central.u32(0x02014b50);
    central.u16(VERSION);
    central.u16(VERSION);
    central.u16(UTF8_NAMES);
    central.u16(method);
    central.u16(time);
    central.u16(date);
    central.u32(crc);
    central.u32(payload.length);
    central.u32(data.length);
    central.u16(name.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(offset);
    central.bytes(name);
    count++;
  }

  const centralOffset = out.length;
  out.bytes(new Uint8Array(await central.toBlob("").arrayBuffer()));
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(count);
  out.u16(count);
  out.u32(central.length);
  out.u32(centralOffset);
  out.u16(0);
  return out.toBlob("application/zip");
}
