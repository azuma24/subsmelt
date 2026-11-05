import fs from "node:fs";
import path from "node:path";
import {
  compileCorrectionsFor,
  correctCueText,
  correctionRuleError,
  totalCorrections,
  type CompiledCorrection,
  type CorrectionRule,
} from "../shared/corrections.js";
import type { ScanResult } from "../shared/scan.js";
import type { ApplyReport, ScanMatch, ScanReport } from "../shared/corrections.js";
import { correctSubtitleContent, correctSubtitleFile, mediaRelativePath } from "./corrections.js";
import { cuesOf, parseSubtitle } from "./translator/convert.js";
import { getJob, forceJobs } from "./db.js";
import { getTasks, preferredChinese } from "./config.js";
import { fileLangCodes } from "./language-codes.js";
import { errorMessage } from "./errors.js";

/**
 * "Fix everywhere": find which subtitles in some folders a set of rules would
 * change (a dry run with sample lines), then apply them to the files a person
 * ticked, optionally re-translating the sources that changed. Sources and
 * translations are told apart by the library scan, so a translation is fixed
 * by output rules and a source by source rules, never the other way round.
 */

const SUBTITLE_EXTS = new Set(["srt", "vtt", "ass", "ssa"]);
const MAX_FILES = 2000;
const SAMPLES_PER_FILE = 2;
const SAMPLE_CHARS = 120;

export interface CorrectionTarget {
  /** Absolute path. */
  path: string;
  kind: "source" | "output";
  /** Output: the target language codes of its task. */
  langCodes: string[];
  /** Source: the finished translation jobs made from it, which a re-translate would redo. */
  jobs: Array<{ id: number; langCode: string; tokens: number }>;
}

/** Validate rules from a request; throws a readable error for the first bad one. */
export function checkRules(rules: readonly CorrectionRule[]): void {
  if (!rules.length) throw new Error("No rules given");
  for (const rule of rules) {
    const error = correctionRuleError(rule);
    if (error) throw new Error(`"${rule.find}": ${error}`);
  }
}

function compile(rules: readonly CorrectionRule[], stage: "source" | "output", langCodes: string[] = []) {
  const set = { id: "request", name: "", enabled: true, paths: [""], rules: [...rules] };
  return compileCorrectionsFor([set], "", stage, langCodes);
}

/** Every subtitle the library knows about, as a source or a translation of one. */
export function correctionTargets(library: ScanResult): CorrectionTarget[] {
  const tasks = getTasks();
  const preferred = preferredChinese();
  const targets = new Map<string, CorrectionTarget>();
  for (const file of library.files) {
    for (const subtitle of file.subtitles) {
      const jobs: CorrectionTarget["jobs"] = [];
      for (const scanned of subtitle.tasks) {
        const task = tasks.find((t) => t.id === scanned.taskId);
        if (scanned.outputExists && fs.existsSync(scanned.outputPath) && !targets.has(scanned.outputPath)) {
          targets.set(scanned.outputPath, {
            path: scanned.outputPath,
            kind: "output",
            langCodes: task ? fileLangCodes(task, preferred) : [scanned.langCode],
            jobs: [],
          });
        }
        if (scanned.jobId !== null && (scanned.status === "done" || scanned.status === "skipped")) {
          const job = getJob(scanned.jobId);
          if (job)
            jobs.push({
              id: job.id,
              langCode: scanned.langCode,
              tokens: (job.input_tokens ?? 0) + (job.output_tokens ?? 0),
            });
        }
      }
      targets.set(subtitle.srtPath, { path: subtitle.srtPath, kind: "source", langCodes: [], jobs });
    }
  }
  return [...targets.values()];
}

function inFolders(relative: string, folders: readonly string[]): boolean {
  return folders.some((folder) => folder === "" || relative === folder || relative.startsWith(`${folder}/`));
}

function clip(text: string, at: number): string {
  const flat = text.replace(/\s*\r?\n\s*/g, " ⏎ ");
  if (flat.length <= SAMPLE_CHARS) return flat;
  const start = Math.max(0, Math.min(at - SAMPLE_CHARS / 2, flat.length - SAMPLE_CHARS));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + SAMPLE_CHARS)}${start + SAMPLE_CHARS < flat.length ? "…" : ""}`;
}

function rulesFor(target: CorrectionTarget, rules: readonly CorrectionRule[]): CompiledCorrection[] {
  // A rule set to leave this file alone (an exception from an earlier fix) skips it here too.
  const relative = mediaRelativePath(target.path);
  const apply = rules.filter((rule) => !(relative !== null && rule.except?.includes(relative)));
  return target.kind === "source" ? compile(apply, "source") : compile(apply, "output", target.langCodes);
}

/** What the rules would change in one file, without writing it. */
function scanFile(target: CorrectionTarget, compiled: CompiledCorrection[]): Omit<ScanMatch, "relative"> | null {
  const ext = path.extname(target.path).slice(1).toLowerCase();
  const bytes = fs.readFileSync(target.path);
  let content: string;
  let error: string | undefined;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    content = bytes.toString("utf8");
    error = "not UTF-8, so it cannot be rewritten";
  }
  const samples: ScanMatch["samples"] = [];
  let count = 0;
  for (const cue of cuesOf(parseSubtitle(content, ext))) {
    const text = String(cue.data?.text ?? "");
    const result = correctCueText(text, compiled);
    const n = totalCorrections(result.counts);
    if (!n) continue;
    count += n;
    if (samples.length < SAMPLES_PER_FILE) {
      const at = text.search(compiled[0]?.pattern ?? /$/);
      samples.push({ before: clip(text, at), after: clip(result.text, at) });
    }
  }
  if (!count) return null;
  if (!error) {
    try {
      correctSubtitleContent(content, ext, compiled);
    } catch (e) {
      error = errorMessage(e) || String(e);
    }
  }
  return { path: target.path, kind: target.kind, count, samples, jobs: target.jobs, ...(error ? { error } : {}) };
}

/**
 * Dry run: the files under `folders` (MEDIA_DIR-relative, "" for all), or
 * exactly `files`, that the rules would change, with counts and sample lines.
 */
export function scanForCorrections(
  library: ScanResult,
  rules: readonly CorrectionRule[],
  scope: { folders?: readonly string[]; files?: readonly string[] },
): ScanReport {
  checkRules(rules);
  const wanted = scope.files ? new Set(scope.files.map((f) => path.resolve(f))) : null;
  const inScope = correctionTargets(library).filter((target) => {
    const relative = mediaRelativePath(target.path);
    if (relative === null || !SUBTITLE_EXTS.has(path.extname(target.path).slice(1).toLowerCase())) return false;
    if (wanted) return wanted.has(path.resolve(target.path));
    return inFolders(relative, scope.folders ?? []);
  });
  const matches: ScanMatch[] = [];
  for (const target of inScope.slice(0, MAX_FILES)) {
    const compiled = rulesFor(target, rules);
    if (!compiled.length) continue;
    try {
      const match = scanFile(target, compiled);
      if (match) matches.push({ ...match, relative: mediaRelativePath(target.path) ?? target.path });
    } catch {
      // Unreadable or unparseable: nothing to fix there.
    }
  }
  matches.sort((a, b) => a.relative.localeCompare(b.relative));
  return {
    matches,
    filesScanned: Math.min(inScope.length, MAX_FILES),
    totalMatches: matches.reduce((sum, m) => sum + m.count, 0),
    truncated: inScope.length > MAX_FILES,
  };
}

/**
 * Apply the rules to exactly these files. Each path must be a subtitle the
 * library knows (a file outside it is refused, not guessed at), and is fixed
 * with the rules for its kind. With `retranslate`, the finished translations
 * of every source that changed are queued again from scratch.
 */
export function applyCorrections(
  library: ScanResult,
  rules: readonly CorrectionRule[],
  files: readonly string[],
  retranslate: boolean,
): ApplyReport {
  checkRules(rules);
  const targets = new Map(correctionTargets(library).map((target) => [path.resolve(target.path), target]));
  const results: ApplyReport["results"] = [];
  const requeue: number[] = [];
  for (const file of files) {
    const target = targets.get(path.resolve(file));
    if (!target) {
      results.push({ path: file, total: 0, error: "not a subtitle in the library" });
      continue;
    }
    const result = correctSubtitleFile(target.path, rulesFor(target, rules));
    results.push({ path: target.path, total: result.total, ...(result.error ? { error: result.error } : {}) });
    if (retranslate && target.kind === "source" && result.total > 0) requeue.push(...target.jobs.map((job) => job.id));
  }
  return {
    results,
    totalFixed: results.reduce((sum, r) => sum + r.total, 0),
    retranslated: requeue.length ? forceJobs(requeue) : 0,
  };
}
