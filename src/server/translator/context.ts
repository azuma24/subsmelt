import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { logger } from "../logger.js";
import { getAi, normalizeResult, withAbortTimeout, REQUEST_TIMEOUT_MS, extractUsage, type CloudProvider, type TokenUsage } from "./ai-client.js";
import { ContextOverflowError } from "./context-overflow.js";
import { DEFAULT_ANALYSIS_LINES, MIN_ANALYSIS_LINES, analysisLinesFor } from "./context-probe.js";

export async function analyzeSubtitlesForContext(
  subtitles: string[],
  opts: {
    apiKey: string;
    apiHost: string;
    model: string;
    provider?: CloudProvider;
    lang: string;
    temperature?: number;
    abortSignal?: AbortSignal;
    /** Dynamic cap derived from probeModelContext(). Defaults to 2000. */
    maxAnalysisLines?: number;
    /** Per-job request timeout in ms. */
    requestTimeoutMs?: number;
    /** Fired after the analysis generateText with its token usage. */
    onUsage?: (u: TokenUsage) => void;
  }
): Promise<string> {
  if (!opts.model || subtitles.length === 0) return "";

  // Context analysis runs for every non-empty file regardless of length — short
  // clips (tech talks, interviews) still carry glossary-worthy terms, and the
  // active-glossary / series-memory paths depend on this result.

  // The probe's line cap is a guess (and a blind default off LM Studio), so an
  // overflow resends a smaller sample until it fits or is too small to be useful.
  let sample = sampleLines(subtitles, opts.maxAnalysisLines ?? DEFAULT_ANALYSIS_LINES);
  for (;;) {
    try {
      return await requestAnalysis(sample, opts);
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) throw error;
      const fewer = fewerAnalysisLines(sample.length, error.contextTokens);
      if (fewer === null) throw error;
      logger.warn(
        "translate",
        `Context analysis overflowed ${opts.model}'s context window with ${sample.length} lines; retrying with ${fewer}`
      );
      sample = sampleLines(subtitles, fewer);
    }
  }
}

/** An evenly-spaced sample so early, mid, and late content is all represented. */
function sampleLines(subtitles: string[], max: number): string[] {
  if (subtitles.length <= max) return subtitles;
  const step = subtitles.length / max;
  return Array.from({ length: max }, (_, i) => subtitles[Math.min(Math.round(i * step), subtitles.length - 1)]);
}

/**
 * The next, smaller sample size after an overflow: half, or what the reported
 * window holds if that is smaller. Null once the sample cannot usefully shrink.
 */
function fewerAnalysisLines(current: number, contextTokens: number | null): number | null {
  const half = Math.floor(current / 2);
  const fits = contextTokens ? analysisLinesFor(contextTokens) : half;
  const next = Math.max(MIN_ANALYSIS_LINES, Math.min(half, fits));
  return next < current ? next : null;
}

async function requestAnalysis(
  sample: string[],
  opts: Parameters<typeof analyzeSubtitlesForContext>[1]
): Promise<string> {
  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost, provider: opts.provider });
  const result = normalizeResult(await withAbortTimeout((abortSignal) =>
    generateText({
      model: ai(opts.model),
      temperature: opts.temperature ?? 0.3,
      system: `# System Prompt

You are a subtitle content analyst assisting a translation and glossary extraction system.

## Task
Analyze subtitle samples and return two outputs:
1. **Plot Summary**
   - Language: ${opts.lang}
   - Length: 5–10 sentences
   - Must be clear, coherent, and written in natural ${opts.lang}
   - Avoid literal stitching of subtitles

2. **Glossary**
   - Up to 50 items
   - Include rare words, character names, places, organizations, fictional elements, or jargon
   - Each entry should include:
     - term (required)
     - description (required)
     - category (optional: person, place, organization, jargon, fictional, other)
     - preferredTranslation (optional)
     - notes (optional)

## Output format
Use exactly this markdown structure:
### 📝 Plot Summary
<summary text>

### 📚 Glossary
- term: ... | description: ... | category: ... | preferredTranslation: ... | notes: ...`,
      prompt:
        `Produce plot summary in ${opts.lang} and glossary from this subtitle sample:\n` +
        sample.join("\n"),
      maxRetries: 0,
      abortSignal,
    }),
    opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    opts.abortSignal
  ));

  if (opts.onUsage) {
    const usage = extractUsage(result);
    if (usage) opts.onUsage(usage);
  }

  return result.text?.trim() || "";
}

// ── Active Glossary Injection (§1) ──────────────────────────────────────────
// A parsed glossary entry: a source term and its preferred translation.
export interface GlossaryEntry {
  term: string;
  translation: string;
}

/**
 * Parse the free-text analysis blob produced by analyzeSubtitlesForContext into
 * structured {term, translation} pairs. The analyst emits glossary lines in the
 * form:
 *   - term: X | description: ... | category: ... | preferredTranslation: Y | notes: ...
 * Only entries that carry a non-empty preferredTranslation are kept; everything
 * else is skipped. Purely additive: if nothing parses, returns an empty array
 * and callers fall back to existing behavior.
 */
export function parseGlossaryFromAnalysis(analysis: string): GlossaryEntry[] {
  if (!analysis) return [];
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of analysis.split("\n")) {
    const line = rawLine.trim();
    // Glossary lines start with a bullet and contain pipe-separated fields.
    if (!line.startsWith("-")) continue;
    if (!/term\s*:/i.test(line)) continue;

    const fields = line.replace(/^-\s*/, "").split("|");
    let term = "";
    let translation = "";
    for (const field of fields) {
      const sep = field.indexOf(":");
      if (sep === -1) continue;
      const key = field.slice(0, sep).trim().toLowerCase();
      const value = field.slice(sep + 1).trim();
      if (key === "term") term = value;
      else if (key === "preferredtranslation") translation = value;
    }

    if (!term || !translation) continue;
    // Treat placeholder/empty markers as missing.
    if (/^(\.{3}|n\/a|none|-)$/i.test(translation)) continue;

    const dedupeKey = term.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    entries.push({ term, translation });
  }
  return entries;
}

/**
 * Given a chunk's source text and the parsed glossary, return only the entries
 * whose source term appears (case-insensitively) somewhere in that text. Keeps
 * the per-chunk glossary block small and relevant.
 */
export function scanForGlossaryTerms(text: string, glossary: GlossaryEntry[]): GlossaryEntry[] {
  if (!text || glossary.length === 0) return [];
  const haystack = text.toLowerCase();
  return glossary.filter((entry) => {
    const needle = entry.term.toLowerCase().trim();
    return needle.length > 0 && haystack.includes(needle);
  });
}

/**
 * Render a compact per-chunk glossary block to prepend to a chunk's prompt.
 * Returns "" when there are no present terms (additive, no-op behavior).
 */
export function buildChunkGlossaryBlock(present: GlossaryEntry[]): string {
  if (present.length === 0) return "";
  const lines = present.map((e) => `- ${e.term} -> ${e.translation}`);
  return `Current Chunk Glossary:\n${lines.join("\n")}\n\n`;
}

// ── Series-Wide Memory (§2) ─────────────────────────────────────────────────
// Persistent per-folder glossary file. Carries glossary terms across files in
// the same media folder so a series stays consistent.
const SERIES_GLOSSARY_FILENAME = ".subsmelt_glossary.json";

export interface SeriesGlossary {
  terms: Record<string, string>;
  updatedAt: string;
}

function seriesGlossaryPath(srtPath: string): string {
  return path.join(path.dirname(srtPath), SERIES_GLOSSARY_FILENAME);
}

/**
 * Load the series glossary sitting next to the file being translated. Never
 * throws: any read/parse failure yields an empty glossary so a translation is
 * never blocked by a missing or corrupt memory file.
 */
export function loadSeriesGlossary(srtPath: string): SeriesGlossary {
  const empty: SeriesGlossary = { terms: {}, updatedAt: "" };
  try {
    const file = seriesGlossaryPath(srtPath);
    if (!fs.existsSync(file)) return empty;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.terms !== "object" || parsed.terms === null) {
      return empty;
    }
    const terms: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.terms as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
        terms[k] = v;
      }
    }
    return { terms, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "" };
  } catch {
    return empty;
  }
}

/**
 * Merge newly-extracted entries into the series glossary file and write it back.
 * Add new terms; existing terms keep their value unless the stored value is
 * empty. Never throws — a write failure must not fail the translation.
 * Returns true on a successful write, false otherwise.
 */
export function mergeSeriesGlossary(srtPath: string, newEntries: GlossaryEntry[]): boolean {
  try {
    const current = loadSeriesGlossary(srtPath);
    const terms: Record<string, string> = { ...current.terms };
    let changed = false;
    for (const entry of newEntries) {
      const existing = terms[entry.term];
      if (!existing || !existing.trim()) {
        if (terms[entry.term] !== entry.translation) {
          terms[entry.term] = entry.translation;
          changed = true;
        }
      }
    }
    if (!changed && current.updatedAt) return false;
    const out: SeriesGlossary = { terms, updatedAt: new Date().toISOString() };
    fs.writeFileSync(seriesGlossaryPath(srtPath), JSON.stringify(out, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Render a series glossary as a [Series Glossary] block to seed effectiveAdditional
 * so prior files' terms carry over into this file's translation. Returns "" when
 * there are no terms.
 */
export function buildSeriesGlossarySeed(series: SeriesGlossary): string {
  const lines = Object.entries(series.terms)
    .filter(([k, v]) => k.trim() && v.trim())
    .map(([k, v]) => `- term: ${k} | preferredTranslation: ${v}`);
  if (lines.length === 0) return "";
  return `[Series Glossary]\n${lines.join("\n")}`;
}

/** The two glossary views a translateFile job needs, derived once per file. */
export interface ChunkGlossaryResult {
  /** Every known term (parsed from this file's analysis + prior series terms),
   *  deduped by lowercase term, for per-chunk scanning. */
  chunkGlossary: GlossaryEntry[];
  /** Only the terms freshly parsed from THIS file's analysis — what gets
   *  merged back into the series glossary file. */
  parsedGlossary: GlossaryEntry[];
}

/**
 * Active Glossary Injection (§1) — parse the analysis blob into structured
 * {term, translation} pairs once, then merge the series glossary on top so
 * every known term is available for per-chunk scanning. Purely additive: if
 * nothing parses, this is an empty list and chunk prompts are unchanged.
 */
export function buildChunkGlossary(
  analysis: string,
  seriesGlossary: SeriesGlossary | null
): ChunkGlossaryResult {
  const parsedGlossary = parseGlossaryFromAnalysis(analysis);
  const glossaryByTerm = new Map<string, GlossaryEntry>();
  for (const e of parsedGlossary) glossaryByTerm.set(e.term.toLowerCase(), e);
  if (seriesGlossary) {
    for (const [term, translation] of Object.entries(seriesGlossary.terms)) {
      const key = term.toLowerCase();
      if (term.trim() && translation.trim() && !glossaryByTerm.has(key)) {
        glossaryByTerm.set(key, { term, translation });
      }
    }
  }
  const chunkGlossary: GlossaryEntry[] = Array.from(glossaryByTerm.values());
  return { chunkGlossary, parsedGlossary };
}
