import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

// Per-folder sidecar caching translated media titles, mirroring the
// .subsmelt_glossary.json series-memory sidecar in context.ts: graceful
// read/write, never throws, purely additive.
export const TITLE_SIDECAR_FILENAME = ".subsmelt_titles.json";

export interface TitleSidecar {
  version: 1;
  titles: Record<string, Record<string, string>>; // base -> langCode -> translated title
}

const EMPTY_SIDECAR: TitleSidecar = { version: 1, titles: {} };

function titleSidecarPath(dir: string): string {
  return path.join(dir, TITLE_SIDECAR_FILENAME);
}

/**
 * Load the title sidecar from a directory. Never throws: a missing file,
 * unreadable path, or corrupt JSON all yield an empty sidecar so a
 * translation is never blocked by a missing or corrupt cache.
 */
export function loadTitleSidecar(dir: string): TitleSidecar {
  try {
    const file = titleSidecarPath(dir);
    if (!fs.existsSync(file)) return EMPTY_SIDECAR;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.titles !== "object" || parsed.titles === null) {
      return EMPTY_SIDECAR;
    }
    const titles: Record<string, Record<string, string>> = {};
    for (const [base, byLang] of Object.entries(parsed.titles as Record<string, unknown>)) {
      if (typeof base !== "string" || !byLang || typeof byLang !== "object") continue;
      const langs: Record<string, string> = {};
      for (const [lang, title] of Object.entries(byLang as Record<string, unknown>)) {
        if (typeof lang === "string" && typeof title === "string" && lang.trim() && title.trim()) {
          langs[lang] = title;
        }
      }
      if (Object.keys(langs).length > 0) titles[base] = langs;
    }
    return { version: 1, titles };
  } catch {
    return EMPTY_SIDECAR;
  }
}

/** Look up a cached translated title, if any. */
export function getTitle(sidecar: TitleSidecar, base: string, langCode: string): string | undefined {
  return sidecar.titles[base]?.[langCode];
}

/**
 * Return a new sidecar with (base, langCode) -> title merged in. Immutable:
 * never mutates the input sidecar or its nested objects.
 */
export function withTitle(sidecar: TitleSidecar, base: string, langCode: string, title: string): TitleSidecar {
  const existingForBase = sidecar.titles[base] ?? {};
  return {
    version: sidecar.version,
    titles: {
      ...sidecar.titles,
      [base]: { ...existingForBase, [langCode]: title },
    },
  };
}

/**
 * Merge two sidecars: entries from `overlay` win per (base, langCode); any
 * on-disk (base, langCode) pair absent from `overlay` is preserved.
 */
function mergeSidecars(onDisk: TitleSidecar, overlay: TitleSidecar): TitleSidecar {
  const bases = new Set([...Object.keys(onDisk.titles), ...Object.keys(overlay.titles)]);
  const titles: Record<string, Record<string, string>> = {};
  for (const base of bases) {
    titles[base] = { ...(onDisk.titles[base] ?? {}), ...(overlay.titles[base] ?? {}) };
  }
  return { version: 1, titles };
}

/** Write JSON to `file` atomically via a temp file + rename. */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Write the title sidecar to a directory. Merge-on-write: re-loads the
 * on-disk sidecar first and deep-merges it with `sidecar` (in-memory values
 * win per (base, langCode)), so concurrent multi-process writers don't erase
 * each other's entries. Never throws — a write failure must not fail the
 * translation.
 */
export function saveTitleSidecar(dir: string, sidecar: TitleSidecar): void {
  try {
    const onDisk = loadTitleSidecar(dir);
    const merged = mergeSidecars(onDisk, sidecar);
    writeJsonAtomic(titleSidecarPath(dir), merged);
  } catch (e: any) {
    logger.warn("translate", `Title sidecar write failed: ${titleSidecarPath(dir)} — ${e?.message || e}`);
  }
}

/**
 * Remove title entries whose base is not in `validBases`, writing the
 * result directly (not merge-on-write, since pruning must actually delete
 * stale entries). Deletes the sidecar file entirely if no entries remain.
 * Never throws. No-op when the sidecar file doesn't exist.
 */
export function pruneTitleSidecar(dir: string, validBases: ReadonlySet<string>): void {
  try {
    const file = titleSidecarPath(dir);
    if (!fs.existsSync(file)) return;

    const sidecar = loadTitleSidecar(dir);
    const titles: Record<string, Record<string, string>> = {};
    for (const [base, langs] of Object.entries(sidecar.titles)) {
      if (validBases.has(base)) titles[base] = langs;
    }

    if (Object.keys(titles).length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    writeJsonAtomic(file, { version: 1, titles });
  } catch (e: any) {
    logger.warn("translate", `Title sidecar prune failed: ${titleSidecarPath(dir)} — ${e?.message || e}`);
  }
}

// ── cleanMediaTitle ──────────────────────────────────────────────────────────

const YEAR_PATTERN = /^(19|20)\d{2}$/;
const RESOLUTION_PATTERN = /^(480p|576p|720p|1080p|2160p|4K)$/i;
const SOURCE_PATTERN = /^(BluRay|Blu-Ray|WEB-?DL|WEBRip|HDTV|BRRip|DVDRip|HDRip|REMUX)$/i;
const CODEC_PATTERN = /^(x264|x265|h264|h265|HEVC|AVC|AV1|XviD|DivX)$/i;
const AUDIO_PATTERN = /^(AAC|AC3|EAC3|DTS|DDP?|DD5 1|TrueHD|Atmos|FLAC)$/i;
const MISC_PATTERN = /^(PROPER|REPACK|EXTENDED|UNRATED|LIMITED|INTERNAL|COMPLETE|MULTi|DUBBED|SUBBED|HDR|HDR10|DV|10bit)$/i;
// SxxEyy, multi-episode SxxEyy-Eyy / SxxEyyEyy, and "1x05" style markers.
const EPISODE_MARKER_PATTERN = /^(S\d{2}E\d{2}(-?E\d{2})?|\d{1,2}x\d{2,3})$/i;
const BRACKET_TAG_PATTERN = /\[[^\]]*\]/g;

const CUT_PATTERNS = [YEAR_PATTERN, RESOLUTION_PATTERN, SOURCE_PATTERN, CODEC_PATTERN, AUDIO_PATTERN, MISC_PATTERN];

function matchesCutPattern(token: string): boolean {
  return CUT_PATTERNS.some((pattern) => pattern.test(token));
}

// A release group rides the last tag as "x264-SPARKS"; only such compound
// tokens are cut — a bare "-Suffix" is left alone so hyphenated titles like
// "Spider-Man" survive.
function isCutToken(token: string): boolean {
  if (EPISODE_MARKER_PATTERN.test(token)) return false;
  if (matchesCutPattern(token)) return true;
  const hyphenIndex = token.indexOf("-");
  return hyphenIndex > 0 && matchesCutPattern(token.slice(0, hyphenIndex));
}

/** First index > 0 whose token is a cut token, or -1 if none (index 0 is never cut). */
function findCutIndex(tokens: string[]): number {
  for (let i = 1; i < tokens.length; i += 1) {
    if (isCutToken(tokens[i])) return i;
  }
  return -1;
}

/** Drop a lone trailing "-" token left dangling after cuts/bracket stripping. */
function stripDanglingTrailingDash(tokens: string[]): string[] {
  if (tokens.length > 1 && tokens[tokens.length - 1] === "-") {
    return tokens.slice(0, -1);
  }
  return tokens;
}

/**
 * Derive a human-readable media title from a release-style filename stem,
 * e.g. "Inception.2010.1080p.BluRay.x264-SPARKS" -> "Inception". Strips
 * bracket tags (e.g. "[SubsPlease]") entirely before tokenizing, unwraps
 * parenthesized tokens (so "(2010)" cuts like a bare year), and cuts at the
 * first year/resolution/source/codec/audio/misc release tag (including
 * "tag-GROUP" compounds), keeping any SxxEyy/1x05-style episode marker.
 * Falls back to the separator-spaced original when the result would be
 * empty.
 */
export function cleanMediaTitle(stem: string): string {
  const debracketed = stem.replace(BRACKET_TAG_PATTERN, " ");
  const spaced = debracketed.replace(/[._]/g, " ").replace(/[()]/g, "");
  const tokens = spaced.split(/\s+/).filter(Boolean);
  const cutIndex = findCutIndex(tokens);
  const kept = stripDanglingTrailingDash(cutIndex === -1 ? tokens : tokens.slice(0, cutIndex));

  const cleaned = kept.join(" ").replace(/\s+/g, " ").trim();

  return cleaned || spaced.trim();
}

// ── sanitizeTitle ────────────────────────────────────────────────────────────

// One-layer wrapping quote pairs to strip: guillemets, curly/straight
// double quotes, straight single quotes, Japanese corner brackets.
const WRAPPING_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["«", "»"], // « »
  ["“", "”"], // “ ”
  ['"', '"'],
  ["'", "'"],
  ["「", "」"], // 「 」
];

function stripWrappingQuotes(text: string): string {
  for (const [open, close] of WRAPPING_QUOTE_PAIRS) {
    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length);
    }
  }
  return text;
}

/**
 * Clean raw LLM translation output into a bare title: take the first
 * non-empty line, trim, strip one layer of wrapping quotes, trim again.
 * Returns "" if nothing usable remains — the caller decides what to do.
 */
export function sanitizeTitle(raw: string): string {
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "";
  return stripWrappingQuotes(firstLine.trim()).trim();
}

// ── ensureTranslatedTitle ─────────────────────────────────────────────────────

export interface EnsureTitleOptions {
  outputDir: string;
  base: string; // media base stem, e.g. "Inception.2010.1080p.BluRay.x264-GROUP"
  langCode: string; // e.g. "zh"
  translate: (text: string) => Promise<string>; // injected translator
  force?: boolean; // bypass the cached-title skip and re-translate, overwriting the cache
}

// Parallel queue workers can target the same folder (one job per language),
// and a scan-time prune can overlap an in-flight title write. Serialize
// sidecar read-modify-write per directory so concurrent updates never
// overwrite each other's entries. In-process is sufficient: the queue and
// scanner run in a single server process.
const dirLocks = new Map<string, Promise<unknown>>();

/** Prune serialized behind the same per-directory lock as title writes. */
export function pruneTitleSidecarQueued(dir: string, validBases: ReadonlySet<string>): Promise<void> {
  return withDirLock(dir, async () => pruneTitleSidecar(dir, validBases));
}

async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  dirLocks.set(dir, run.catch(() => undefined));
  return run;
}

/**
 * Return the translated title for (base, langCode), caching it in the
 * per-folder title sidecar. Skips translation entirely when a cached title
 * already exists, unless `force` is set. The translate() result is run
 * through sanitizeTitle before caching; an empty sanitized result throws
 * and no sidecar write happens. On translate() failure, the error is
 * rethrown and no sidecar write happens.
 */
export async function ensureTranslatedTitle(opts: EnsureTitleOptions): Promise<string> {
  return withDirLock(opts.outputDir, async () => {
    const sidecar = loadTitleSidecar(opts.outputDir);
    if (!opts.force) {
      const existing = getTitle(sidecar, opts.base, opts.langCode);
      if (existing !== undefined) return existing;
    }

    const cleaned = cleanMediaTitle(opts.base);
    const translated = await opts.translate(cleaned);
    const sanitized = sanitizeTitle(translated);
    if (!sanitized) {
      logger.warn("translate", `Empty title from translator for base "${opts.base}" (${opts.langCode})`);
      throw new Error("empty title from translator");
    }

    const updated = withTitle(sidecar, opts.base, opts.langCode, sanitized);
    saveTitleSidecar(opts.outputDir, updated);
    return sanitized;
  });
}
