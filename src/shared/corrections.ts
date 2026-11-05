/**
 * Subtitle corrections: user-defined find → replace rules, run on cue text
 * after speech-to-text (the "source" stage, before translation) and after
 * translation (the "output" stage, before the file is saved).
 *
 * Stored as a JSON array of rule sets in the `correction_rule_sets` setting. A
 * set applies to the media folders it names (and every subfolder), so the
 * fixes for one library — "Ubiquity" → "Ubiquiti" in a UniFi channel — never
 * touch another.
 *
 * Pure: no Node, no DOM. The server runs it on subtitles; the Settings page
 * runs the same code for its "try a line" preview, so the two cannot disagree.
 */

export const CORRECTION_STAGES = ["source", "output", "both"] as const;
export type CorrectionStage = (typeof CORRECTION_STAGES)[number];

/**
 * - `word`: the exact text as a whole word. An edge of the term that is a
 *   letter, digit or underscore must not touch another letter, digit or
 *   underscore — any script, so `超級Unify網路` does not match `Unify`
 *   (Python's Unicode `\b`).
 * - `phrase`: the exact text anywhere, for scripts without spaces
 *   (`優比快` → `Ubiquiti` in a Chinese translation).
 * - `regex`: a JavaScript regular expression (Unicode mode); `$1` works in the
 *   replacement.
 */
export const CORRECTION_MATCH_MODES = ["word", "phrase", "regex"] as const;
export type CorrectionMatchMode = (typeof CORRECTION_MATCH_MODES)[number];

export interface CorrectionRule {
  id: string;
  find: string;
  replace: string;
  stage: CorrectionStage;
  match: CorrectionMatchMode;
  /** Default true: `Unify` and `unify` are separate rules unless this is off. */
  caseSensitive: boolean;
  /**
   * Output stage only: the target language codes this rule applies to
   * (`chi`, `jpn`), matched against the task's code. Empty means every language.
   */
  languages: string[];
  enabled: boolean;
}

export interface CorrectionRuleSet {
  id: string;
  name: string;
  enabled: boolean;
  /** MEDIA_DIR-relative folders, posix, no leading or trailing slash. "" is the whole library. */
  paths: string[];
  rules: CorrectionRule[];
}

/** One rule ready to run. */
export interface CompiledCorrection {
  rule: CorrectionRule;
  /** Rule-set name, for reports. */
  setName: string;
  pattern: RegExp;
}

/** Replacements made, by rule id. A rule with no replacements is absent. */
export type CorrectionCounts = Record<string, number>;

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const BEFORE = "(?<![\\p{L}\\p{N}_])";
const AFTER = "(?![\\p{L}\\p{N}_])";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The rule's pattern; throws when a regex rule does not compile. */
export function correctionPattern(rule: Pick<CorrectionRule, "find" | "match" | "caseSensitive">): RegExp {
  const flags = `gu${rule.caseSensitive ? "" : "i"}`;
  if (rule.match === "regex") return new RegExp(rule.find, flags);
  const body = escapeRegex(rule.find);
  if (rule.match === "phrase") return new RegExp(body, flags);
  const chars = Array.from(rule.find);
  const before = WORD_CHAR.test(chars[0] ?? "") ? BEFORE : "";
  const after = WORD_CHAR.test(chars[chars.length - 1] ?? "") ? AFTER : "";
  return new RegExp(`${before}${body}${after}`, flags);
}

/**
 * Markup that is never corrected and that a term cannot span: SRT/VTT tags
 * (`<i>`, `<00:01.000>`), ASS override blocks (`{\i1}`) and ASS escapes
 * (`\N`, `\n`, `\h`). Each piece between them is matched on its own, so the
 * piece edges count as word boundaries.
 */
const MARKUP = /(<[^<>\n]*>|\{[^{}\n]*\}|\\[Nnh])/;

/** `$1`, `$<name>`, `$&` and `$$` in a regex rule's replacement, as String.replace reads them. */
function expandReplacement(template: string, match: string, groups: unknown[], named: unknown): string {
  return template.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (whole, token: string, name?: string, digits?: string) => {
    if (token === "$") return "$";
    if (token === "&") return match;
    if (name !== undefined) {
      const value = named && typeof named === "object" ? (named as Record<string, unknown>)[name] : undefined;
      return typeof value === "string" ? value : "";
    }
    const index = Number(digits);
    if (index >= 1 && index <= groups.length)
      return typeof groups[index - 1] === "string" ? (groups[index - 1] as string) : "";
    return whole;
  });
}

function applyToPlain(text: string, item: CompiledCorrection, counts: CorrectionCounts): string {
  const { rule, pattern } = item;
  pattern.lastIndex = 0;
  let replaced = 0;
  const out = text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    let replacement = rule.replace;
    if (rule.match === "regex") {
      // Trailing args: offset, whole string, then the named groups when the pattern has any.
      const hasNamed = typeof args[args.length - 1] === "object";
      const groups = args.slice(1, hasNamed ? -3 : -2);
      replacement = expandReplacement(rule.replace, match, groups, hasNamed ? args[args.length - 1] : undefined);
    }
    if (replacement !== match) replaced++;
    return replacement;
  });
  if (replaced) counts[rule.id] = (counts[rule.id] ?? 0) + replaced;
  return out;
}

/**
 * Apply the rules, in order, to one cue's text. Each line, and each piece of a
 * line between markup, is matched on its own: a term split across lines,
 * cues or tags is not a match. A match already equal to its replacement is not
 * counted (case-insensitive canonicalising rules stay at zero on a second run).
 */
export function correctCueText(
  text: string,
  rules: readonly CompiledCorrection[],
  counts: CorrectionCounts = {},
): { text: string; counts: CorrectionCounts } {
  if (!rules.length || !text) return { text, counts };
  const out = text
    .split(/(\r?\n)/)
    .map((piece, i) => {
      if (i % 2 === 1) return piece;
      return piece
        .split(MARKUP)
        .map((part, j) => {
          if (j % 2 === 1 || !part) return part;
          let next = part;
          for (const item of rules) next = applyToPlain(next, item, counts);
          return next;
        })
        .join("");
    })
    .join("");
  return { text: out, counts };
}

export function totalCorrections(counts: CorrectionCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

// ── Parsing and validation ─────────────────────────────────────────────────

/** Normalise a folder to MEDIA_DIR-relative posix; null when it escapes the root. */
export function normalizeCorrectionPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/\\/g, "/");
  if (cleaned.includes("\0")) return null;
  const parts: string[] = [];
  for (const segment of cleaned.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

const MAX_FIND_LENGTH = 500;

/** Why a rule cannot be saved, or null when it is fine. */
export function correctionRuleError(rule: CorrectionRule): string | null {
  if (!rule.find) return "Find text is empty";
  if (rule.find.length > MAX_FIND_LENGTH) return `Find text is longer than ${MAX_FIND_LENGTH} characters`;
  if (/[\r\n]/.test(rule.find) && rule.match !== "regex") return "Find text cannot span lines";
  let pattern: RegExp;
  try {
    pattern = correctionPattern(rule);
  } catch (error) {
    return `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (pattern.test("")) return "The pattern matches empty text";
  // A rule must be stable: its own replacement must come through it unchanged,
  // or every run would rewrite the file again ("UniFi" → "UniFi Network").
  const self = correctCueText(rule.replace, [{ rule, setName: "", pattern }]);
  if (self.text !== rule.replace) return "The replacement would be changed again by this rule";
  return null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseRule(raw: unknown): CorrectionRule | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const id = str(e.id);
  if (!id) return null;
  const rule: CorrectionRule = {
    id,
    find: str(e.find),
    replace: str(e.replace),
    stage: CORRECTION_STAGES.includes(e.stage as CorrectionStage) ? (e.stage as CorrectionStage) : "source",
    match: CORRECTION_MATCH_MODES.includes(e.match as CorrectionMatchMode) ? (e.match as CorrectionMatchMode) : "word",
    caseSensitive: e.caseSensitive !== false,
    languages: Array.isArray(e.languages)
      ? Array.from(
          new Set(
            e.languages
              .filter((l): l is string => typeof l === "string" && l.trim() !== "")
              .map((l) => l.trim().toLowerCase()),
          ),
        )
      : [],
    enabled: e.enabled !== false,
  };
  return rule;
}

/**
 * Parse the `correction_rule_sets` setting. Malformed sets and rules are
 * dropped, never fatal: a bad entry costs that entry, not every translation.
 */
export function parseCorrectionRuleSets(raw: string | undefined | null): CorrectionRuleSet[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const sets: CorrectionRuleSet[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = str(e.id);
    if (!id) continue;
    const paths = Array.isArray(e.paths)
      ? Array.from(new Set(e.paths.map(normalizeCorrectionPath).filter((p): p is string => p !== null)))
      : [];
    const rules = Array.isArray(e.rules) ? e.rules.map(parseRule).filter((r): r is CorrectionRule => r !== null) : [];
    sets.push({ id, name: str(e.name), enabled: e.enabled !== false, paths, rules });
  }
  return sets;
}

/**
 * Every problem that should stop a save, as readable messages. Checked on
 * save so a broken rule is refused up front instead of being skipped silently
 * at translation time.
 */
export function correctionRuleSetsErrors(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || "[]");
  } catch {
    return ["Correction rules must be valid JSON"];
  }
  if (!Array.isArray(value)) return ["Correction rules must be a JSON array"];
  const errors: string[] = [];
  const sets = parseCorrectionRuleSets(raw);
  if (sets.length !== value.length) errors.push("Every rule set needs an id");
  for (const set of sets) {
    const label = set.name || set.id;
    if (!set.paths.length) errors.push(`${label}: choose at least one folder`);
    for (const rule of set.rules) {
      const error = correctionRuleError(rule);
      if (error) errors.push(`${label}: "${rule.find}": ${error}`);
    }
    // Rules that feed each other (A → B, then B → A) rewrite the file on every
    // run; the file check refuses them too, so refuse them here first.
    const compiled = compileSet(set, () => true);
    for (const rule of set.rules) {
      for (const probe of [rule.find, rule.replace]) {
        if (rule.match === "regex" || !probe) continue;
        const once = correctCueText(probe, compiled).text;
        if (totalCorrections(correctCueText(once, compiled).counts) > 0) {
          errors.push(`${label}: "${rule.find}": the rules in this set keep changing each other's results`);
          break;
        }
      }
    }
  }
  return errors;
}

function compileSet(set: CorrectionRuleSet, keep: (rule: CorrectionRule) => boolean): CompiledCorrection[] {
  const out: CompiledCorrection[] = [];
  for (const rule of set.rules) {
    if (!rule.enabled || !keep(rule) || correctionRuleError(rule)) continue;
    out.push({ rule, setName: set.name, pattern: correctionPattern(rule) });
  }
  return out;
}

// ── Resolution ──────────────────────────────────────────────────────────────

export function pathInCorrectionScope(relativePath: string, folder: string): boolean {
  return folder === "" || relativePath === folder || relativePath.startsWith(`${folder}/`);
}

/**
 * The rules for one file and stage, in order: sets in list order, rules in
 * set order. `relativePath` is the file's path relative to MEDIA_DIR (posix).
 * `langCodes` — every code that names the task's target language (`chi`,
 * `zh`, `zh-TW`) — filters output-stage rules by language.
 */
export function compileCorrectionsFor(
  sets: readonly CorrectionRuleSet[],
  relativePath: string,
  stage: "source" | "output",
  langCodes: readonly string[] = [],
): CompiledCorrection[] {
  const langs = new Set(langCodes.map((code) => code.toLowerCase()));
  const out: CompiledCorrection[] = [];
  for (const set of sets) {
    if (!set.enabled || !set.paths.some((folder) => pathInCorrectionScope(relativePath, folder))) continue;
    out.push(
      ...compileSet(set, (rule) => {
        if (rule.stage !== stage && rule.stage !== "both") return false;
        if (stage === "output" && rule.languages.length && !rule.languages.some((l) => langs.has(l))) return false;
        return true;
      }),
    );
  }
  return out;
}

/** A stable fingerprint of the rules, so finished work is redone when they change. */
export function correctionsFingerprint(rules: readonly CompiledCorrection[]): string {
  return JSON.stringify(rules.map(({ rule }) => [rule.find, rule.replace, rule.match, rule.caseSensitive]));
}

/**
 * Terms the translator should keep exactly as written: the replacement of
 * each plain (non-regex) source rule. Fed to the per-chunk glossary, so the
 * LLM is told "Ubiquiti -> Ubiquiti" whenever a chunk mentions it.
 */
export function correctionGlossaryTerms(rules: readonly CompiledCorrection[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const { rule } of rules) {
    const term = rule.replace.trim();
    if (rule.match === "regex" || !term || !/[\p{L}\p{N}]/u.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/** Per-rule counts with the rule's text, for a log line or a report. */
export function describeCorrections(
  counts: CorrectionCounts,
  rules: readonly CompiledCorrection[],
): Array<{ find: string; replace: string; count: number }> {
  return rules
    .filter(({ rule }) => counts[rule.id])
    .map(({ rule }) => ({ find: rule.find, replace: rule.replace, count: counts[rule.id] }));
}
