import type { SubtitleQualityIssue } from "../../shared/subtitle-quality.js";
import { assField, cuesOf, isAssDocument, parseSubtitle } from "./convert.js";
import { strictCueTime } from "./srt-vtt.js";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WIDE = /[\uFF01-\uFF60\uFFE0-\uFFE6\p{Extended_Pictographic}]/u;
const SPACE = /^\s+$/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Display text for measurement and plain-text SRT export. */
export function visibleCueText(text: string, ext: string): string {
  if (ext === "ass" || ext === "ssa") {
    return text
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ");
  }
  return text
    .replace(/<\/?(?:b|i|u|s|font|c|v|lang|ruby|rt)(?=[\s.>])[^>]*>/gi, "")
    .replace(/<(?:\d+:)?\d{2}:\d{2}\.\d{3}>/g, "");
}

export function inspectSubtitle(
  content: string,
  ext: string,
  policy?: { maxLineWidth?: number; maxReadingSpeed?: number },
) {
  const issues: SubtitleQualityIssue[] = [];
  const parsed = parseSubtitle(content, ext, (line) => issues.push({ code: "invalidTiming", line }));
  const cues = cuesOf(parsed);
  if (!cues.length && !issues.length) issues.push({ code: "noCues" });
  const dialogue = isAssDocument(parsed)
    ? parsed.full.find((section) => section.section === "Events")?.body.filter((line) => line.key === "Dialogue")
    : undefined;
  const timed: { cue: number; start: number; end: number; layer: string }[] = [];

  cues.forEach(({ data }, index) => {
    const cue = index + 1;
    const start = strictCueTime(data?.start);
    const end = strictCueTime(data?.end);
    const duration = start === null || end === null ? 0 : end - start;
    if (start === null || end === null || duration <= 0) {
      issues.push({ cue, code: "invalidTiming" });
    } else {
      if (duration < 800) issues.push({ cue, code: "short", value: duration, limit: 800 });
      if (duration > 7000) issues.push({ cue, code: "long", value: duration, limit: 7000 });
      const line = dialogue?.[index];
      const layer = line ? assField(line.value, "Layer") || assField(line.value, "Marked") || "0" : "0";
      timed.push({ cue, start, end, layer });
    }

    const text = visibleCueText(data?.text ?? "", ext)
      .replace(/&(?:nbsp|lrm|rlm);/gi, " ")
      .replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, "x")
      .trim();
    if (!text) {
      issues.push({ cue, code: "empty" });
      return;
    }
    const lines = text.split(/\r?\n/);
    if (lines.length > 2) issues.push({ cue, code: "lines", value: lines.length, limit: 2 });
    let maxWidth = 0;
    let characters = 0;
    let cjk = 0;
    for (const line of lines) {
      let width = 0;
      for (const { segment } of GRAPHEMES.segment(line.trim())) {
        const isCjk = CJK.test(segment);
        width += isCjk || WIDE.test(segment) ? 2 : 1;
        if (isCjk) cjk++;
        if (!SPACE.test(segment)) characters++;
      }
      maxWidth = Math.max(maxWidth, width);
    }
    const widthLimit = policy?.maxLineWidth ?? 42;
    if (maxWidth > widthLimit) issues.push({ cue, code: "width", value: maxWidth, limit: widthLimit });
    const speedLimit = policy?.maxReadingSpeed ?? (cjk * 2 > characters ? 9 : 20);
    const speed = duration > 0 ? (characters * 1000) / duration : 0;
    if (speed > speedLimit) issues.push({ cue, code: "speed", value: Math.round(speed * 10) / 10, limit: speedLimit });
  });

  // Compare on the timeline, including a long cue that contains several short
  // ones. ASS cues on different layers can intentionally be visible together.
  const furthestEnd = new Map<string, number>();
  timed.sort((a, b) => a.start - b.start || a.cue - b.cue);
  for (const { cue, start, end, layer } of timed) {
    const previousEnd = furthestEnd.get(layer) ?? 0;
    if (previousEnd > start) issues.push({ cue, code: "overlap", value: Math.min(previousEnd, end) - start });
    furthestEnd.set(layer, Math.max(previousEnd, end));
  }
  issues.sort((a, b) => (a.cue ?? 0) - (b.cue ?? 0));
  return { cues, issues };
}
