/**
 * Decode a dropped subtitle file's bytes into text. The work is the shared
 * detector in src/shared/charset.ts, which the server uses for files on
 * disk: a byte-order mark decides, valid UTF-8 is UTF-8, and a legacy
 * encoding (Big5, Shift_JIS, GBK, windows-1252, ...) is recognised from the
 * text it would produce. The async signature is kept for the callers that
 * await it.
 */
import { decodeSubtitleBytes as decodeBytes } from "../../../shared/charset";

export { decodeWindows1252, detectLegacyEncoding } from "../../../shared/charset";

export async function decodeSubtitleBytes(bytes: Uint8Array): Promise<string> {
  return decodeBytes(bytes);
}

export async function readSubtitleFile(file: Blob): Promise<string> {
  return decodeBytes(new Uint8Array(await file.arrayBuffer()));
}
