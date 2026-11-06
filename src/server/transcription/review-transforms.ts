import { z } from "zod";
import { stringifyAss } from "../translator/ass.js";
import { isAssDocument, parseSubtitle, toAssTimestamp } from "../translator/convert.js";
import { formatTimestamp, strictCueTime } from "../translator/srt-vtt.js";

const operationsSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("offset"), milliseconds: z.number().int().min(-86_400_000).max(86_400_000) }),
      z.strictObject({
        kind: z.literal("frameRate"),
        from: z.number().min(1).max(240),
        to: z.number().min(1).max(240),
      }),
      z.strictObject({ kind: z.literal("balance"), width: z.number().int().min(8).max(200) }),
    ]),
  )
  .min(1)
  .max(20);

type Operation = z.infer<typeof operationsSchema>[number];

function timing(start: number, end: number, operation: Operation) {
  const shift = (time: number) =>
    operation.kind === "offset"
      ? time + operation.milliseconds
      : operation.kind === "frameRate"
        ? Math.round((time * operation.from) / operation.to)
        : time;
  const nextStart = Math.max(0, shift(start));
  const nextEnd = Math.max(0, shift(end));
  if (!Number.isSafeInteger(nextStart) || !Number.isSafeInteger(nextEnd) || nextEnd <= nextStart) {
    throw new Error("The transform collapses a cue or produces an invalid timestamp");
  }
  return [nextStart, nextEnd] as const;
}

function balance(text: string, width: number, lineBreak: string): string {
  // Leave styled cues, speaker labels, and intentional blank lines intact.
  if (/[<>{}\\]|(?:^|\n)\s*[-–—]|\r?\n\s*\r?\n/.test(text)) return text;
  const words = text.trim().split(/\s+/);
  const length = (value: string) => [...value].length;
  const joined = words.join(" ");
  if (length(joined) <= width) return joined;
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && length(`${line} ${word}`) > width) {
      lines.push(line);
      line = "";
    }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length === 2) {
    // Try all word boundaries for a balanced two-line cue within the limit.
    const total = length(joined);
    let left = 0;
    let best = -1;
    let gap = total;
    for (let index = 0; index < words.length - 1; index++) {
      left += length(words[index]) + (index === 0 ? 0 : 1);
      const right = total - left - 1;
      if (left <= width && right <= width && Math.abs(left - right) < gap) {
        best = index + 1;
        gap = Math.abs(left - right);
      }
    }
    if (best !== -1) return [words.slice(0, best).join(" "), words.slice(best).join(" ")].join(lineBreak);
  }
  return lines.join(lineBreak);
}

function transformAss(content: string, ext: string, operations: Operation[]): string {
  const doc = parseSubtitle(content, ext);
  if (!isAssDocument(doc)) throw new Error("Expected ASS or SSA subtitle");
  const lines = doc.full.find(({ section }) => section === "Events")?.body ?? [];
  for (const line of lines) {
    const fields = line.value;
    if (line.key !== "Dialogue" || typeof fields !== "object" || Array.isArray(fields)) continue;
    for (const operation of operations) {
      if (operation.kind === "balance") {
        if (!/\\[nNh]/.test(fields.Text ?? "")) fields.Text = balance(fields.Text ?? "", operation.width, "\\N");
      } else {
        const start = strictCueTime(fields.Start);
        const end = strictCueTime(fields.End);
        if (start === null || end === null) throw new Error("The transcript contains invalid timestamps");
        const [nextStart, nextEnd] = timing(start, end, operation);
        fields.Start = toAssTimestamp(nextStart);
        fields.End = toAssTimestamp(nextEnd);
        if (fields.Start === fields.End) throw new Error("The transform collapses a cue at ASS timestamp precision");
      }
    }
  }
  return stringifyAss(doc.full);
}

export function transformReviewSubtitle(content: string, ext: string, requested: unknown): string {
  const operations = operationsSchema.parse(requested);
  if (ext === "ass" || ext === "ssa") return transformAss(content, ext, operations);
  if (ext !== "srt" && ext !== "vtt") throw new Error("Expected a timed subtitle");
  // Work on cue blocks so WebVTT headers, identifiers, metadata and cue settings survive.
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return content
    .split(/((?:\r?\n[\t ]*){2,})/)
    .map((block) => {
      if (ext === "vtt" && /^\s*\uFEFF?(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block)) return block;
      const match = /^((?:[^\r\n]*\r?\n)?[\t ]*)(\S+)([\t ]+-->[\t ]+)(\S+)([^\r\n]*)(\r?\n|$)([\s\S]*)$/.exec(block);
      if (!match) return block;
      const [, before, from, arrow, until, settings, newline, cueText] = match;
      let start = strictCueTime(from);
      let end = strictCueTime(until);
      if (start === null || end === null) throw new Error("The transcript contains invalid timestamps");
      let text = cueText;
      for (const operation of operations) {
        if (operation.kind === "balance")
          text = balance(text.trimEnd(), operation.width, eol) + text.slice(text.trimEnd().length);
        else [start, end] = timing(start, end, operation);
      }
      const format = ext === "vtt" ? "WebVTT" : "SRT";
      return before + formatTimestamp(start, format) + arrow + formatTimestamp(end, format) + settings + newline + text;
    })
    .join("");
}
