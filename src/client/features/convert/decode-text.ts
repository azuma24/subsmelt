import jschardet from "jschardet";

/**
 * Decode a dropped subtitle file's bytes into text, handling BOMs and the
 * legacy single- and multi-byte encodings older subtitle files still use
 * (Big5, Shift_JIS, GBK, Windows-1252...). Mirrors the server's
 * readSubtitleFileText: BOM first, then a strict UTF-8 attempt, then charset
 * sniffing, and UTF-8 with replacement characters as the last resort.
 */

/** Below this jschardet confidence a guess is not trusted over UTF-8. */
const MIN_CONFIDENCE = 0.6;
/** Sniffing more than this many bytes adds nothing for subtitle files. */
const SNIFF_BYTES = 256 * 1024;

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

function tryDecode(bytes: Uint8Array, encoding: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/** jschardet wants a "binary string": one char per byte. */
function binaryString(bytes: Uint8Array): string {
  const sample = bytes.subarray(0, SNIFF_BYTES);
  let out = "";
  for (let i = 0; i < sample.length; i += 8192) {
    out += String.fromCharCode(...sample.subarray(i, i + 8192));
  }
  return out;
}

export function sniffEncoding(bytes: Uint8Array): string | null {
  const guess = jschardet.detect(binaryString(bytes));
  const encoding = (guess?.encoding ?? "").toLowerCase();
  if (!encoding || encoding === "ascii" || encoding === "utf-8" || encoding === "utf8") return null;
  return (guess.confidence ?? 0) >= MIN_CONFIDENCE ? encoding : null;
}

export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (hasPrefix(bytes, UTF8_BOM)) return new TextDecoder("utf-8").decode(bytes);
  if (hasPrefix(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes);
  if (hasPrefix(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes);

  const utf8 = tryDecode(bytes, "utf-8", true);
  if (utf8 !== null) return utf8;

  const sniffed = sniffEncoding(bytes);
  const legacy = sniffed ? tryDecode(bytes, sniffed, false) : null;
  return legacy ?? new TextDecoder("utf-8").decode(bytes);
}

export async function readSubtitleFile(file: Blob): Promise<string> {
  return decodeSubtitleBytes(new Uint8Array(await file.arrayBuffer()));
}
