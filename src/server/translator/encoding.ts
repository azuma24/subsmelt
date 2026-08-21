import fs from "node:fs";
import jschardet from "jschardet";
import iconv from "iconv-lite";

/**
 * Read a subtitle file from disk and return its content as a clean UTF-8 JS
 * string, transparently handling legacy non-UTF-8 encodings and byte-order
 * marks (BOMs) so older subtitle files no longer mojibake or fail to parse.
 *
 * Strategy:
 *   1. Read the raw bytes (no encoding hint).
 *   2. If a UTF-8 BOM (EF BB BF) is present, strip it and decode as UTF-8.
 *   3. If a UTF-16 LE (FF FE) or BE (FE FF) BOM is present, decode as UTF-16.
 *   4. Otherwise sniff the charset with jschardet; when confidence is
 *      reasonable and the detected charset is not already UTF-8/ASCII, decode
 *      with iconv-lite. Default to UTF-8 in every other case.
 *
 * Defensive by design: any detection/decoding failure falls back to a plain
 * UTF-8 decode, so this helper never throws where the previous
 * `fs.readFileSync(path, "utf8")` would have succeeded.
 */
export function readSubtitleFileText(filePath: string): string {
  const buffer = fs.readFileSync(filePath);

  // BOM handling — explicit and unambiguous, checked before any sniffing.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    // UTF-8 with BOM: strip the 3 BOM bytes, decode the rest as UTF-8.
    return buffer.subarray(3).toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    // UTF-16 LE BOM. Node's "utf16le" decode does NOT strip the BOM, so drop
    // the leading 2 BOM bytes ourselves to avoid a stray U+FEFF char.
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16 BE BOM. Node has no native utf16be; swap byte pairs to LE, then
    // drop the (now-LE) BOM bytes.
    const body = buffer.subarray(2);
    const swapped = Buffer.from(body);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = tmp;
    }
    return swapped.toString("utf16le");
  }

  // No BOM: sniff the charset and decode via iconv-lite when warranted.
  try {
    const detected = jschardet.detect(buffer);
    const encoding = (detected?.encoding || "").toLowerCase();
    const confidence = detected?.confidence ?? 0;
    const isUtf8OrAscii =
      encoding === "" ||
      encoding === "utf-8" ||
      encoding === "utf8" ||
      encoding === "ascii";

    if (!isUtf8OrAscii && confidence >= 0.6 && iconv.encodingExists(encoding)) {
      return iconv.decode(buffer, encoding);
    }
  } catch {
    // Detection failed — fall through to a safe UTF-8 decode.
  }

  // Common case (and safe fallback): decode as UTF-8, identical to the old
  // `fs.readFileSync(path, "utf8")` behavior.
  return buffer.toString("utf8");
}
