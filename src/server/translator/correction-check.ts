import { generateText } from "ai";
import { mapCueMatches, type CompiledCorrection, type CorrectionCounts } from "../../shared/corrections.js";
import {
  extractUsage,
  getAi,
  normalizeResult,
  REQUEST_TIMEOUT_MS,
  withAbortTimeout,
  type CloudProvider,
  type TokenUsage,
} from "./ai-client.js";
import { extractJsonFromText } from "./text-coercion.js";

/**
 * "Check with the translator" for correction rules whose term is also an
 * ordinary word: "unify" is the brand Whisper misheard in "open the unify
 * app", and the verb in "we unify the dashboards". Every cue such a rule
 * would change is put to the LLM with its neighbours, in batches, and only a
 * confirmed "yes" is replaced. Anything else — a "no", a missing or garbled
 * answer, a failed request — keeps the cue as it is: the check can only ever
 * do less than the plain rule would.
 */

const BATCH_SIZE = 40;
const CHECK_MAX_OUTPUT_TOKENS = 2000;

export interface CheckConnection {
  apiKey: string;
  apiHost: string;
  model: string;
  provider?: CloudProvider;
}

export interface CheckResult {
  texts: string[];
  /** Replacements made after a "yes", by rule id. */
  confirmed: CorrectionCounts;
  /** Matches left alone after a "no" or no usable answer, by rule id. */
  kept: CorrectionCounts;
  /** Batches whose request failed; their matches were all kept. */
  failedBatches: number;
}

/** One occurrence to ask about: the `n`-th changing match of the rule in cue `cue`. */
interface Question {
  id: number;
  cue: number;
  n: number;
  item: CompiledCorrection;
}

/** The cue with only the asked-about occurrence marked «like this». */
function marked(text: string, item: CompiledCorrection, n: number): string {
  return mapCueMatches(text, item, (match, _replacement, i) => (i === n ? `«${match}»` : match));
}

function occurrences(text: string, item: CompiledCorrection): number {
  let count = 0;
  mapCueMatches(text, item, (match) => {
    count++;
    return match;
  });
  return count;
}

function oneLine(text: string | undefined): string {
  return (text ?? "").replace(/\s*\r?\n\s*/g, " / ").trim();
}

/** Parse `[{"id": 3, "replace": true}, …]` (or `{"answers": [...]}`), keeping only well-formed yes/no answers. */
export function parseAnswers(raw: string): Map<number, boolean> {
  const parsed = extractJsonFromText(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { answers?: unknown }).answers)
      ? (parsed as { answers: unknown[] }).answers
      : [];
  const answers = new Map<number, boolean>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { id, replace } = entry as { id?: unknown; replace?: unknown };
    if (typeof id === "number" && typeof replace === "boolean") answers.set(id, replace);
  }
  return answers;
}

export function buildCheckPrompt(questions: readonly Question[], texts: readonly string[]): string {
  const items = questions.map(({ id, cue, n, item }) => ({
    id,
    before: oneLine(texts[cue - 1]),
    line: oneLine(marked(texts[cue], item, n)),
    after: oneLine(texts[cue + 1]),
    term: item.rule.find,
    replaceWith: item.rule.replace,
  }));
  return `Each item is a subtitle line with one term marked «like this», and the lines around it. The term may be a speech-recognition or translation mistake for the name or term in "replaceWith", or it may be meant exactly as written (an ordinary word).

For each item answer "replace": true only if the marked term is clearly meant to be "replaceWith" in this line; answer false when it is an ordinary word or you are not sure.

Answer with JSON only, one entry per item, in this form: [{"id": 0, "replace": true}]

${JSON.stringify(items, null, 1)}`;
}

/**
 * Confirm each match of `rules` (all "check with the translator" rules) in
 * `texts`, cue by cue, and apply the confirmed ones in rule order. `ask` sends
 * one prompt to the LLM; tests replace it.
 */
export async function checkCorrections(
  texts: readonly string[],
  rules: readonly CompiledCorrection[],
  ask: (prompt: string) => Promise<string>,
): Promise<CheckResult> {
  const out = [...texts];
  const confirmed: CorrectionCounts = {};
  const kept: CorrectionCounts = {};
  let failedBatches = 0;
  for (const item of rules) {
    // One question per occurrence, so "the unify app to unify the dashboards" can get yes and no.
    const questions: Question[] = [];
    out.forEach((text, cue) => {
      const count = occurrences(text, item);
      for (let n = 0; n < count; n++) questions.push({ id: questions.length, cue, n, item });
    });
    const yes = new Map<number, Set<number>>();
    for (let start = 0; start < questions.length; start += BATCH_SIZE) {
      const batch = questions.slice(start, start + BATCH_SIZE);
      let answers = new Map<number, boolean>();
      try {
        answers = parseAnswers(await ask(buildCheckPrompt(batch, out)));
      } catch (error) {
        if (error instanceof Error && (error.message === "STOP_REQUESTED" || error.message === "JOB_CANCELLED"))
          throw error;
        failedBatches++;
      }
      for (const { id, cue, n } of batch) {
        if (answers.get(id) === true) {
          if (!yes.has(cue)) yes.set(cue, new Set());
          yes.get(cue)?.add(n);
          confirmed[item.rule.id] = (confirmed[item.rule.id] ?? 0) + 1;
        } else {
          kept[item.rule.id] = (kept[item.rule.id] ?? 0) + 1;
        }
      }
    }
    // Every question for this rule asked about the text as it stood; apply the yeses together.
    for (const [cue, ns] of yes) {
      out[cue] = mapCueMatches(out[cue], item, (match, replacement, n) => (ns.has(n) ? replacement : match));
    }
  }
  return { texts: out, confirmed, kept, failedBatches };
}

/** An `ask` that sends the prompt to one connection. */
export function askConnection(
  conn: CheckConnection,
  opts: { abortSignal?: AbortSignal; requestTimeoutMs?: number; onUsage?: (u: TokenUsage) => void },
): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const ai = getAi({ apiKey: conn.apiKey, apiHost: conn.apiHost, provider: conn.provider });
    const result = normalizeResult(
      await withAbortTimeout(
        (abortSignal) =>
          generateText({
            model: ai(conn.model),
            temperature: 0,
            system: "You check subtitle corrections. You answer with JSON only.",
            prompt,
            maxRetries: 1,
            maxOutputTokens: CHECK_MAX_OUTPUT_TOKENS,
            abortSignal,
          }),
        opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        opts.abortSignal,
      ),
    );
    const usage = extractUsage(result);
    if (usage) opts.onUsage?.(usage);
    return result.text ?? "";
  };
}
