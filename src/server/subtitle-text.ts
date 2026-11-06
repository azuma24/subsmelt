import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { cuesOf, parseSubtitle } from "./translator/convert.js";
import { strictCueTime } from "./translator/srt-vtt.js";
import { visibleCueText } from "./translator/subtitle-quality.js";

const MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** Read a regular subtitle with a hard byte limit even if it grows after stat. */
export async function readSubtitleText(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_TEXT_BYTES) throw new Error("Subtitle is too large or is not a file.");
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new Error("Subtitle changed during reading.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

export function hasValidSubtitleText(content: string, format: string): boolean {
  let invalid = false;
  const cues = cuesOf(
    parseSubtitle(content, format, () => {
      invalid = true;
    }),
  );
  return (
    !invalid &&
    cues.length > 0 &&
    cues.some(({ data }) => visibleCueText(data?.text ?? "", format).trim()) &&
    cues.every(({ data }) => {
      const start = strictCueTime(data?.start);
      const end = strictCueTime(data?.end);
      return start !== null && end !== null && end > start;
    })
  );
}
