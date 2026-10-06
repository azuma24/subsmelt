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

/**
 * Labels the WHATWG Encoding Standard maps to windows-1252. Browsers decode
 * them with the windows-1252 table, but Node's TextDecoder takes a latin1
 * fast path for the same labels and leaves 0x80–0x9F as C1 control
 * characters (an em dash becomes U+0097). Decoding this family by hand keeps
 * the output identical in every runtime.
 */
const WINDOWS_1252_LABELS = new Set([
  "windows-1252", "cp1252", "x-cp1252", "ansi_x3.4-1968", "ascii", "us-ascii",
  "iso-8859-1", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "latin1", "l1",
  "cp819", "ibm819", "csisolatin1", "iso-ir-100",
]);

/** Code points for bytes 0x80–0x9F in windows-1252; undefined bytes keep their C1 value. */
const WINDOWS_1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

export function decodeWindows1252(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    units[i] = b >= 0x80 && b <= 0x9f ? WINDOWS_1252_C1[b - 0x80] : b;
  }
  let out = "";
  for (let i = 0; i < units.length; i += 8192) {
    out += String.fromCharCode(...units.subarray(i, i + 8192));
  }
  return out;
}

function tryDecode(bytes: Uint8Array, encoding: string, fatal: boolean): string | null {
  if (WINDOWS_1252_LABELS.has(encoding.toLowerCase())) return decodeWindows1252(bytes);
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
