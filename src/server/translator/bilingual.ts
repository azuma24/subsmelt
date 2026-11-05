import { cuesOf, parseSubtitle } from "./convert.js";
import { strictCueTime, stringifySubtitle, type SubtitleCueNode } from "./srt-vtt.js";
import { visibleCueText } from "./subtitle-quality.js";

export function bilingualSrt(
  source: { content: string; ext: string },
  target: { content: string; ext: string },
): string | null {
  let invalidTiming = false;
  const markInvalid = () => {
    invalidTiming = true;
  };
  const original = cuesOf(parseSubtitle(source.content, source.ext, markInvalid));
  const translated = cuesOf(parseSubtitle(target.content, target.ext, markInvalid));
  if (invalidTiming || !original.length || original.length !== translated.length) return null;

  // ASS/SSA conversion rounds millisecond clocks down to centiseconds.
  const tolerance = [source.ext, target.ext].some((ext) => ext === "ass" || ext === "ssa") ? 9 : 0;
  const cues: SubtitleCueNode[] = [];
  for (const [index, cue] of original.entries()) {
    const other = translated[index];
    const start = strictCueTime(cue.data?.start);
    const end = strictCueTime(cue.data?.end);
    const targetStart = strictCueTime(other.data?.start);
    const targetEnd = strictCueTime(other.data?.end);
    if (
      start === null ||
      end === null ||
      end <= start ||
      targetStart === null ||
      targetEnd === null ||
      targetEnd <= targetStart ||
      Math.abs(start - targetStart) > tolerance ||
      Math.abs(end - targetEnd) > tolerance
    ) {
      return null;
    }
    const text = [
      visibleCueText(cue.data?.text ?? "", source.ext).trim(),
      visibleCueText(other.data?.text ?? "", target.ext).trim(),
    ]
      .filter(Boolean)
      .join("\n");
    cues.push({ type: "cue", data: { start, end, text } });
  }
  return stringifySubtitle(cues, "SRT");
}
