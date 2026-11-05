/**
 * SRT and WebVTT as a list of nodes: a header node for the WEBVTT block, and
 * one cue node per cue. Parsing is line by line, so a cue whose text holds a
 * blank line keeps it, and lenient: NOTE, STYLE and REGION blocks, cue
 * identifiers and the odd junk block are skipped rather than fatal, and a
 * file with nothing usable parses to no cues at all.
 */

export interface SubtitleCueNode {
  type: "cue";
  data: {
    /** Milliseconds. */
    start: number;
    end: number;
    text: string;
    /** WebVTT cue settings after the timing line (`align:start position:10%`). */
    settings?: string;
  };
}

export interface SubtitleHeaderNode {
  type: "header";
  /** The WEBVTT block, trimmed. */
  data: string;
}

export type SubtitleNode = SubtitleCueNode | SubtitleHeaderNode;

export type SubtitleFormat = "SRT" | "WebVTT";

/** A node as the stringifier accepts it: a parsed node, or a cue built from one with the times already in milliseconds. */
export interface StringifyNode {
  type?: string;
  data?: string | { start?: number | string; end?: number | string; text?: string; settings?: string };
}

const TIMING_RE = /^((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})(?:\s+(.*))?$/;
const INDEX_RE = /^\d+$/;
const SKIPPED_BLOCK_RE = /^(NOTE|STYLE|REGION)(\s|$)/;
const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/;

/** `HH:MM:SS,mmm` or `MM:SS.mmm` in milliseconds; a short fraction is a fraction (`,5` is 500 ms). */
export function parseTimestamp(value: string): number {
  const match = TIMESTAMP_RE.exec(value);
  if (!match) throw new Error(`Invalid SRT or VTT time format: "${value}"`);
  const hours = match[1] ? Number(match[1]) * 3_600_000 : 0;
  return hours + Number(match[2]) * 60_000 + Number(match[3]) * 1000 + Number(match[4].padEnd(3, "0"));
}

/** A valid cue clock, including a genuine time zero. */
export function strictCueTime(value: number | string | undefined): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const timestamp = value.trim();
  const match = TIMESTAMP_RE.exec(timestamp);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return null;
  const ms = parseTimestamp(timestamp);
  return Number.isSafeInteger(ms) ? ms : null;
}

function timingOf(line: string, onInvalid?: () => void): SubtitleCueNode["data"] | null {
  const match = TIMING_RE.exec(line.trim());
  if (!match) return null;
  if (onInvalid && (strictCueTime(match[1]) === null || strictCueTime(match[2]) === null)) onInvalid();
  const data: SubtitleCueNode["data"] = { start: parseTimestamp(match[1]), end: parseTimestamp(match[2]), text: "" };
  if (match[3]) data.settings = match[3].trim();
  return data;
}

type State = "header" | "id" | "timing" | "text" | "skip";

export function parseSrtVtt(
  content: string,
  format?: SubtitleFormat,
  onInvalidTiming?: (line: number) => void,
): SubtitleNode[] {
  const nodes: SubtitleNode[] = [];
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  const vtt = format === "WebVTT" || /^\s*WEBVTT(?:\s|$)/.test(content);
  let state: State = "header";
  let cue: SubtitleCueNode["data"] | null = null;
  let buffer: string[] = [];

  const flushCue = () => {
    if (!cue) return;
    while (buffer.length > 0 && buffer[buffer.length - 1] === "") buffer.pop();
    while (buffer.length > 0 && buffer[0] === "") buffer.shift();
    nodes.push({ type: "cue", data: { ...cue, text: buffer.join("\n") } });
    cue = null;
    buffer = [];
  };

  for (const [index, line] of lines.entries()) {
    if (state === "header") {
      if (!line.trim()) continue;
      if (vtt && /^WEBVTT(?:\s|$)/.test(line)) {
        buffer.push(line);
        state = "skip";
        // The header block ends at the first blank line, like a NOTE block.
        continue;
      }
      state = "id";
    }

    if (state === "skip") {
      if (line.trim()) {
        if (buffer.length > 0) buffer.push(line);
        continue;
      }
      if (buffer.length > 0) nodes.push({ type: "header", data: buffer.join("\n").trim() });
      buffer = [];
      state = "id";
      continue;
    }

    const timing = timingOf(line, onInvalidTiming && (() => onInvalidTiming(index + 1)));
    if (onInvalidTiming && !timing && /^\s*\S+\s+-->/.test(line)) {
      const lastBlank = buffer.lastIndexOf("");
      if (state !== "text" || (lastBlank >= 0 && buffer.length - lastBlank <= 2)) onInvalidTiming(index + 1);
    }

    if (state === "id" || state === "timing") {
      if (!line.trim()) {
        state = "id";
        continue;
      }
      if (timing) {
        cue = timing;
        buffer = [];
        state = "text";
        continue;
      }
      if (state === "id" && (!vtt || !SKIPPED_BLOCK_RE.test(line))) {
        // An index or a cue identifier: the timing line follows.
        state = "timing";
        continue;
      }
      // A NOTE/STYLE/REGION block, or two lines without a timing between them: skip to the next blank line.
      state = "skip";
      continue;
    }

    // state === "text"
    if (timing) {
      // A blank line ends a cue, so one line between the last blank and this
      // timing is the new cue's index or identifier, not text. Without a
      // blank, only a bare number is taken for an index (the common SRT case).
      const lastBlank = buffer.lastIndexOf("");
      if (lastBlank >= 0 && buffer.length - lastBlank === 2) buffer.length = lastBlank;
      else if (buffer.length > 0 && INDEX_RE.test(buffer[buffer.length - 1].trim())) buffer.pop();
      flushCue();
      cue = timing;
      state = "text";
      continue;
    }
    if (vtt && buffer.length > 0 && !buffer.at(-1)?.trim() && SKIPPED_BLOCK_RE.test(line)) {
      flushCue();
      state = "skip";
      continue;
    }
    buffer.push(line);
  }
  flushCue();
  return nodes;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Milliseconds as `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (WebVTT); hours grow past two digits when they must. */
export function formatTimestamp(ms: number, format: SubtitleFormat = "SRT"): string {
  const total = Math.max(0, Math.floor(Number.isFinite(ms) ? ms : 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${format === "WebVTT" ? "." : ","}${pad(millis, 3)}`;
}

function toMs(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    try {
      return parseTimestamp(value.trim());
    } catch {
      return Number(value) || 0;
    }
  }
  return 0;
}

/**
 * The nodes as a document. SRT numbers every cue; WebVTT starts with the
 * header node's text, or a bare `WEBVTT` when there is none, and keeps each
 * cue's settings.
 */
export function stringifySubtitle(nodes: ReadonlyArray<StringifyNode>, format: SubtitleFormat): string {
  const vtt = format === "WebVTT";
  let out = "";
  let hasHeader = false;
  let index = 1;
  for (const node of nodes) {
    if (node.type === "header" && vtt && typeof node.data === "string") {
      hasHeader = true;
      out += `${node.data}\n\n`;
      continue;
    }
    if (node.type !== "cue" || !node.data || typeof node.data === "string") continue;
    if (vtt && !hasHeader) {
      hasHeader = true;
      out += "WEBVTT\n\n";
    }
    const { start, end, text, settings } = node.data;
    const timing = `${formatTimestamp(toMs(start), format)} --> ${formatTimestamp(toMs(end), format)}${vtt && settings ? ` ${settings}` : ""}`;
    out += `${index > 1 ? "\n" : ""}${index}\n${timing}\n${text ?? ""}\n`;
    index++;
  }
  return out;
}
