import fs from "node:fs";
import { decodeSubtitleBytes } from "../../shared/charset.js";

/**
 * A subtitle file from disk as text, whatever it was written in: a byte-order
 * mark decides, valid UTF-8 is UTF-8, and a legacy encoding (GBK, Big5,
 * Shift_JIS, windows-125x, ...) is recognised by the detector in
 * src/shared/charset.ts. Never throws where a plain utf8 read would have
 * succeeded: the last resort is UTF-8 with replacement characters.
 */
export function readSubtitleFileText(filePath: string): string {
  return decodeSubtitleBytes(fs.readFileSync(filePath));
}
