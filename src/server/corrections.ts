import fs from "node:fs";
import path from "node:path";
import {
  compileCorrectionsFor,
  correctCueText,
  parseCorrectionRuleSets,
  totalCorrections,
  type CompiledCorrection,
  type CorrectionCounts,
} from "../shared/corrections.js";
import { getSetting } from "./config.js";
import { MEDIA_DIR } from "./scanner.js";
import { cuesOf, normalizeTimeToMs, parseSubtitle } from "./translator/convert.js";
import { errorMessage } from "./errors.js";

/**
 * Applies correction rules to subtitle FILES without disturbing anything but
 * cue text: cue numbers, timings, styles, blank lines, line endings, the BOM
 * and every byte of non-matching text stay as they were. The file is edited
 * line by line rather than parsed and re-serialised, because re-serialising
 * normalises whitespace and timestamps, and a source file rewritten that way
 * would look changed to every tool that reads it.
 */

const TIMING_RE = /^\s*(?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3}\s+-->\s+(?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3}/;
const VTT_SKIPPED_BLOCK_RE = /^(NOTE|STYLE|REGION)(\s|$)/;

/** Lines with their terminators, so joining them gives back the exact input. */
function splitLines(content: string): string[] {
  const lines = content.split(/(?<=\n)/);
  return lines.length && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

function bodyOf(line: string): { body: string; eol: string } {
  const eol = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
  return { body: line.slice(0, line.length - eol.length), eol };
}

/** SRT and WebVTT: a line is cue text when it follows a timing line, up to the next cue's id or timing. */
function correctSrtVtt(content: string, rules: readonly CompiledCorrection[], counts: CorrectionCounts): string {
  const lines = splitLines(content);
  let inCue = false;
  let skipping = false;
  let previousBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const { body, eol } = bodyOf(lines[i]);
    const blank = body.trim() === "";
    if (blank) {
      skipping = false;
      previousBlank = true;
      continue;
    }
    if (TIMING_RE.test(body)) {
      inCue = true;
      skipping = false;
      previousBlank = false;
      continue;
    }
    const nextIsTiming = i + 1 < lines.length && TIMING_RE.test(bodyOf(lines[i + 1]).body);
    if (previousBlank && VTT_SKIPPED_BLOCK_RE.test(body.replace(/^﻿/, ""))) skipping = true;
    previousBlank = false;
    // A cue id (SRT number, VTT identifier) sits right above its timing line.
    if (!inCue || skipping || nextIsTiming) continue;
    const corrected = correctCueText(body, rules, counts).text;
    if (corrected !== body) lines[i] = corrected + eol;
  }
  return lines.join("");
}

/** ASS/SSA: only the Text field of Dialogue lines in [Events]. */
function correctAss(content: string, rules: readonly CompiledCorrection[], counts: CorrectionCounts): string {
  const lines = splitLines(content);
  let inEvents = false;
  let textField = 9;
  for (let i = 0; i < lines.length; i++) {
    const { body, eol } = bodyOf(lines[i]);
    const trimmed = body.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = trimmed.toLowerCase() === "[events]";
      continue;
    }
    if (!inEvents) continue;
    const format = /^Format\s*:(.*)$/i.exec(trimmed);
    if (format) {
      const fields = format[1].split(",").map((f) => f.trim().toLowerCase());
      const index = fields.indexOf("text");
      textField = index >= 0 ? index : fields.length - 1;
      continue;
    }
    const dialogue = /^(\s*Dialogue\s*:\s*)/i.exec(body);
    if (!dialogue) continue;
    // Text is everything after the textField-th comma; it may hold commas itself.
    let cut = dialogue[1].length;
    for (let n = 0; n < textField; n++) {
      const comma = body.indexOf(",", cut);
      if (comma < 0) {
        cut = -1;
        break;
      }
      cut = comma + 1;
    }
    if (cut < 0) continue;
    const text = body.slice(cut);
    const corrected = correctCueText(text, rules, counts).text;
    if (corrected !== text) lines[i] = body.slice(0, cut) + corrected + eol;
  }
  return lines.join("");
}

export interface ContentCorrection {
  content: string;
  counts: CorrectionCounts;
  total: number;
}

/**
 * Correct a subtitle document's cue text. Throws when the result fails
 * validation: the corrected file must parse to the same cues with the same
 * timings, each cue's text must be exactly what the rules make of the
 * original's, and a second pass must change nothing.
 */
export function correctSubtitleContent(
  content: string,
  ext: string,
  rules: readonly CompiledCorrection[],
): ContentCorrection {
  const format = ext.toLowerCase().replace(/^\./, "");
  if (!rules.length) return { content, counts: {}, total: 0 };
  const counts: CorrectionCounts = {};
  let output: string;
  if (format === "srt" || format === "vtt") output = correctSrtVtt(content, rules, counts);
  else if (format === "ass" || format === "ssa") output = correctAss(content, rules, counts);
  else throw new Error(`Unsupported subtitle format: ${format}`);
  const total = totalCorrections(counts);
  if (total === 0) return { content, counts: {}, total: 0 };
  validateCorrection(content, output, format, rules);
  return { content: output, counts, total };
}

function validateCorrection(before: string, after: string, format: string, rules: readonly CompiledCorrection[]): void {
  const original = cuesOf(parseSubtitle(before, format));
  const corrected = cuesOf(parseSubtitle(after, format));
  if (original.length === 0) throw new Error("No subtitle cues found");
  if (original.length !== corrected.length) {
    throw new Error(`Correction changed the cue count (${original.length} → ${corrected.length})`);
  }
  for (let i = 0; i < original.length; i++) {
    const a = original[i].data ?? {};
    const b = corrected[i].data ?? {};
    if (
      normalizeTimeToMs(a.start) !== normalizeTimeToMs(b.start) ||
      normalizeTimeToMs(a.end) !== normalizeTimeToMs(b.end)
    ) {
      throw new Error(`Correction changed the timing of cue ${i + 1}`);
    }
    const expected = correctCueText(String(a.text ?? ""), rules).text;
    if (String(b.text ?? "") !== expected)
      throw new Error(`Correction left cue ${i + 1} different from what the rules give`);
  }
  for (const cue of corrected) {
    const again = correctCueText(String(cue.data?.text ?? ""), rules);
    if (totalCorrections(again.counts) > 0)
      throw new Error("The correction rules are not stable: a second pass changes the text again");
  }
}

export interface FileCorrectionResult {
  /** Replacements written, by rule id. */
  counts: CorrectionCounts;
  total: number;
  /** Set when the file could not be corrected; the file is then left untouched. */
  error?: string;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Correct a subtitle file in place. Atomic (temp file, then rename), keeps
 * the original modification time — the scanner orders mutual translations
 * (`Movie.eng.srt` ↔ `Movie.chi.srt`) by it, so a newer source would swap
 * roles with its own translation — and never re-encodes: a file that is not
 * UTF-8 is reported and left as it is. Never throws.
 */
export function correctSubtitleFile(filePath: string, rules: readonly CompiledCorrection[]): FileCorrectionResult {
  if (!rules.length) return { counts: {}, total: 0 };
  try {
    const bytes = fs.readFileSync(filePath);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { counts: {}, total: 0, error: "the file is not UTF-8, so it was not rewritten" };
    }
    const result = correctSubtitleContent(content, path.extname(filePath), rules);
    if (result.total === 0) return { counts: {}, total: 0 };
    const stat = fs.statSync(filePath);
    const tmp = `${filePath}.${process.pid}.${Date.now()}.corrections.tmp`;
    try {
      // ignoreBOM kept the BOM in `content`; written back as UTF-8 it is the same three bytes.
      const out = Buffer.from(result.content, "utf8");
      if (bytes.subarray(0, 3).equals(UTF8_BOM) && !out.subarray(0, 3).equals(UTF8_BOM)) {
        throw new Error("the byte-order mark was lost");
      }
      fs.writeFileSync(tmp, out, { mode: stat.mode & 0o777 });
      fs.utimesSync(tmp, stat.atime, stat.mtime);
      fs.renameSync(tmp, filePath);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    return { counts: result.counts, total: result.total };
  } catch (error) {
    return { counts: {}, total: 0, error: errorMessage(error) || String(error) };
  }
}

/** A file's path relative to MEDIA_DIR (posix), or null when it lies outside. */
export function mediaRelativePath(filePath: string, mediaDir = MEDIA_DIR): string | null {
  const relative = path.relative(path.resolve(mediaDir), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/** The configured rules for one file and stage; none for a file outside the media folder. */
export function correctionsForFile(
  filePath: string,
  stage: "source" | "output",
  langCodes: readonly string[] = [],
  raw: string = getSetting("correction_rule_sets") || "[]",
): CompiledCorrection[] {
  const relative = mediaRelativePath(filePath);
  if (relative === null) return [];
  return compileCorrectionsFor(parseCorrectionRuleSets(raw), relative, stage, langCodes);
}
