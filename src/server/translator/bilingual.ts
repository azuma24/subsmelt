import { cuesOf, parseSubtitle, type SubtitleCue } from "./convert.js";
import { strictCueTime, stringifySubtitle, type SubtitleCueNode } from "./srt-vtt.js";
import { visibleCueText } from "./subtitle-quality.js";

interface TimedTrack {
  ext: string;
  cues: SubtitleCue[];
  invalidTiming: boolean;
}

export function matchBilingualClocks(source: TimedTrack, target: TimedTrack) {
  if (
    source.invalidTiming ||
    target.invalidTiming ||
    !source.cues.length ||
    source.cues.length !== target.cues.length
  ) {
    return null;
  }

  // ASS/SSA conversion rounds millisecond clocks down to centiseconds.
  const tolerance = [source.ext, target.ext].some((ext) => ext === "ass" || ext === "ssa") ? 9 : 0;
  const clocks: { start: number; end: number }[] = [];
  for (const [index, cue] of source.cues.entries()) {
    const other = target.cues[index];
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
    clocks.push({ start, end });
  }
  return clocks;
}

export function bilingualSrt(
  source: { content: string; ext: string },
  target: { content: string; ext: string },
): string | null {
  function parseTrack(track: { content: string; ext: string }): TimedTrack {
    let invalidTiming = false;
    const cues = cuesOf(
      parseSubtitle(track.content, track.ext, () => {
        invalidTiming = true;
      }),
    );
    return { ext: track.ext, cues, invalidTiming };
  }

  const original = parseTrack(source);
  const translated = parseTrack(target);
  const clocks = matchBilingualClocks(original, translated);
  if (!clocks) return null;

  const cues: SubtitleCueNode[] = clocks.map(({ start, end }, index) => {
    const text = [
      visibleCueText(original.cues[index].data?.text ?? "", source.ext).trim(),
      visibleCueText(translated.cues[index].data?.text ?? "", target.ext).trim(),
    ]
      .filter(Boolean)
      .join("\n");
    return { type: "cue", data: { start, end, text } };
  });
  return stringifySubtitle(cues, "SRT");
}
