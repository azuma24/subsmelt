import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { getAi, normalizeResult, withAbortTimeout, REQUEST_TIMEOUT_MS, type CloudProvider } from "./ai-client.js";

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
  }
): Promise<string> {
  if (!opts.model || subtitles.length === 0) return "";

  // Skip analysis for short files — YouTube clips, interviews, and tech talks
  // under 300 lines have no glossary-worthy content. Analysis would waste tokens
  // and inject useless context into every chunk.
  if (subtitles.length < 300) return "";

  // Cap context analysis to a dynamically computed line count.
  // probeModelContext() reads the model's actual context window from LM Studio's
  // /api/v0/models API and derives a safe cap.  Falls back to 2000 lines for any
  // non-LM-Studio host.  An evenly-spaced sample ensures early, mid, and late
  // content is all represented.
  const MAX_ANALYSIS_LINES = opts.maxAnalysisLines ?? 2000;
  let sample = subtitles;
  if (subtitles.length > MAX_ANALYSIS_LINES) {
    const step = subtitles.length / MAX_ANALYSIS_LINES;
    sample = Array.from({ length: MAX_ANALYSIS_LINES }, (_, i) =>
      subtitles[Math.min(Math.round(i * step), subtitles.length - 1)]
    );
  }

  const ai = getAi({ apiKey: opts.apiKey, apiHost: opts.apiHost, provider: opts.provider });
  const temperature = opts.temperature ?? 0.3;

  try {
    const result = normalizeResult(await withAbortTimeout((abortSignal) =>
      generateText({
        model: ai(opts.model),
        temperature,
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

    return result.text?.trim() || "";
  } catch (e: any) {
    if (e?.message === "STOP_REQUESTED") throw e;
    return "";
  }
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
