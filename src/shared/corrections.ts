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
  /**
   * Files (MEDIA_DIR-relative, posix) the rule never applies to: the ones a
   * person unticked in Fix everywhere and asked to leave alone for good.
   */
  except?: string[];
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

/**
 * A regex rule's replacement, expanded exactly as `String.prototype.replace`
 * does (the spec's GetSubstitution): `$$`, `$&`, `` $` ``, `$'`, `$1`–`$99`
 * (a two-digit reference falls back to one digit plus a literal digit), and
 * `$<name>` only when the pattern has named groups.
 */
function expandReplacement(
  template: string,
  match: string,
  groups: readonly unknown[],
  position: number,
  subject: string,
  named: Record<string, unknown> | undefined,
): string {
  const group = (n: number) => (typeof groups[n - 1] === "string" ? (groups[n - 1] as string) : "");
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    const next = template[i + 1];
    if (ch !== "$" || next === undefined) {
      out += ch;
      continue;
    }
    if (next === "$") {
      out += "$";
      i++;
    } else if (next === "&") {
      out += match;
      i++;
    } else if (next === "`") {
      out += subject.slice(0, position);
      i++;
    } else if (next === "'") {
      out += subject.slice(position + match.length);
      i++;
    } else if (next >= "0" && next <= "9") {
      const two = template.slice(i + 1, i + 3);
      const twoN = /^\d\d$/.test(two) ? Number(two) : 0;
      const oneN = Number(next);
      if (twoN >= 1 && twoN <= groups.length) {
        out += group(twoN);
        i += 2;
      } else if (oneN >= 1 && oneN <= groups.length) {
        out += group(oneN);
        i++;
      } else {
        out += ch;
      }
    } else if (next === "<" && named) {
      const close = template.indexOf(">", i + 2);
      if (close < 0) {
        out += ch;
        continue;
      }
      const value = named[template.slice(i + 2, close)];
      out += typeof value === "string" ? value : "";
      i = close;
    } else {
      out += ch;
    }
  }
  return out;
}

function applyToPlain(text: string, item: CompiledCorrection, counts: CorrectionCounts): string {
  const { rule, pattern } = item;
  pattern.lastIndex = 0;
  let replaced = 0;
  const out = text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    // A zero-length match (a lookahead-only regex) would insert text on every
    // run and never settle; leave it alone. Validation refuses such patterns too.
    if (match === "") return match;
    let replacement = rule.replace;
    if (rule.match === "regex") {
      // Trailing args: offset, whole string, then the named groups when the pattern has any.
      const hasNamed = typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
      const tail = hasNamed ? 3 : 2;
      const groups = args.slice(1, args.length - tail);
      const position = args[args.length - tail] as number;
      const subject = args[args.length - tail + 1] as string;
      const named = hasNamed ? (args[args.length - 1] as Record<string, unknown>) : undefined;
      replacement = expandReplacement(rule.replace, match, groups, position, subject, named);
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

export const CORRECTION_ISSUE_CODES = [
  "invalidJson",
  "notArray",
  "missingId",
  "noFolder",
  "findEmpty",
  "findTooLong",
  "findMultiline",
  "invalidRegex",
  "matchesEmpty",
  "unstableSelf",
  "unstableList",
  "listsConflict",
] as const;
export type CorrectionIssueCode = (typeof CORRECTION_ISSUE_CODES)[number];

/**
 * Why rules cannot be saved, as data: a code plus what it is about. The
 * Settings screens word it in the viewer's language; the server logs and
 * returns the English from describeCorrectionIssue.
 */
export interface CorrectionIssue {
  code: CorrectionIssueCode;
  /** The list it is in (its name, or id when unnamed). */
  list?: string;
  /** The rule's find text. */
  find?: string;
  /** listsConflict: the lists that undo each other, and where ("" is the whole library). */
  lists?: string[];
  folder?: string;
  /** invalidRegex: the engine's message. findTooLong: the limit. */
  detail?: string;
}

/** Why a rule cannot be saved, or null when it is fine. */
export function correctionRuleIssue(rule: CorrectionRule): CorrectionIssue | null {
  const at = { find: rule.find };
  if (!rule.find) return { code: "findEmpty", ...at };
  if (rule.find.length > MAX_FIND_LENGTH) return { code: "findTooLong", ...at, detail: String(MAX_FIND_LENGTH) };
  if (/[\r\n]/.test(rule.find) && rule.match !== "regex") return { code: "findMultiline", ...at };
  let pattern: RegExp;
  try {
    pattern = correctionPattern(rule);
  } catch (error) {
    return { code: "invalidRegex", ...at, detail: error instanceof Error ? error.message : String(error) };
  }
  if (pattern.test("")) return { code: "matchesEmpty", ...at };
  // A lookahead-only pattern matches nowhere and everywhere at once: refuse any
  // zero-length match on the rule's own text.
  for (const sample of [rule.find, rule.replace]) {
    for (const m of sample.matchAll(new RegExp(pattern.source, pattern.flags))) {
      if (m[0] === "") return { code: "matchesEmpty", ...at };
    }
  }
  // A rule must be stable: its own replacement must come through it unchanged,
  // or every run would rewrite the file again ("UniFi" → "UniFi Network").
  const self = correctCueText(rule.replace, [{ rule, setName: "", pattern }]);
  if (self.text !== rule.replace) return { code: "unstableSelf", ...at };
  return null;
}

/** The English wording of an issue, for logs and API errors. */
export function describeCorrectionIssue(issue: CorrectionIssue): string {
  const where = [issue.list, issue.find !== undefined ? `"${issue.find}"` : undefined].filter(Boolean).join(": ");
  const prefix = where ? `${where}: ` : "";
  switch (issue.code) {
    case "invalidJson":
      return "Correction rules must be valid JSON";
    case "notArray":
      return "Correction rules must be a JSON array";
    case "missingId":
      return "Every list needs an id";
    case "noFolder":
      return `${prefix}choose at least one folder`;
    case "findEmpty":
      return `${prefix}Find text is empty`;
    case "findTooLong":
      return `${prefix}Find text is longer than ${issue.detail} characters`;
    case "findMultiline":
      return `${prefix}Find text cannot span lines`;
    case "invalidRegex":
      return `${prefix}Invalid regular expression: ${issue.detail}`;
    case "matchesEmpty":
      return `${prefix}The pattern matches empty text`;
    case "unstableSelf":
      return `${prefix}The replacement would be changed again by this rule`;
    case "unstableList":
      return `${prefix}the rules in this list keep changing each other's results`;
    case "listsConflict":
      return `Lists ${(issue.lists ?? []).map((n) => `"${n}"`).join(" and ")} undo each other in ${issue.folder || "the whole library"} ("${issue.find}")`;
  }
}

/** Why a rule cannot be saved, in English, or null when it is fine. */
export function correctionRuleError(rule: CorrectionRule): string | null {
  const issue = correctionRuleIssue(rule);
  return issue ? describeCorrectionIssue({ ...issue, find: undefined }) : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** One rule from untrusted JSON, with defaults filled in; null without an id. */
export function parseCorrectionRule(raw: unknown): CorrectionRule | null {
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
  const except = Array.isArray(e.except)
    ? Array.from(new Set(e.except.map(normalizeCorrectionPath).filter((p): p is string => Boolean(p))))
    : [];
  if (except.length) rule.except = except;
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
    const rules = Array.isArray(e.rules)
      ? e.rules.map(parseCorrectionRule).filter((r): r is CorrectionRule => r !== null)
      : [];
    sets.push({ id, name: str(e.name), enabled: e.enabled !== false, paths, rules });
  }
  return sets;
}

/** Every problem that should stop a save, as issues the screens word in the viewer's language. */
export function correctionRuleSetsIssues(raw: string): CorrectionIssue[] {
  let value: unknown;
  try {
    value = JSON.parse(raw || "[]");
  } catch {
    return [{ code: "invalidJson" }];
  }
  if (!Array.isArray(value)) return [{ code: "notArray" }];
  const issues: CorrectionIssue[] = [];
  const sets = parseCorrectionRuleSets(raw);
  if (sets.length !== value.length) issues.push({ code: "missingId" });
  for (const set of sets) {
    const list = set.name || set.id;
    if (!set.paths.length) issues.push({ code: "noFolder", list });
    for (const rule of set.rules) {
      const issue = correctionRuleIssue(rule);
      if (issue) issues.push({ ...issue, list });
    }
    // Rules that feed each other (A → B, then B → A) rewrite the file on every
    // run; the file check refuses them too, so refuse them here first.
    const compiled = compileSet(set, () => true);
    for (const rule of set.rules) {
      for (const probe of [rule.find, rule.replace]) {
        if (rule.match === "regex" || !probe) continue;
        const once = correctCueText(probe, compiled).text;
        if (totalCorrections(correctCueText(once, compiled).counts) > 0) {
          issues.push({ code: "unstableList", list, find: rule.find });
          break;
        }
      }
    }
  }
  issues.push(...crossListConflicts(sets));
  return issues;
}

/**
 * Every problem that should stop a save, as readable (English) messages.
 * Checked on save so a broken rule is refused up front instead of being
 * skipped silently at translation time.
 */
export function correctionRuleSetsErrors(raw: string): string[] {
  return correctionRuleSetsIssues(raw).map(describeCorrectionIssue);
}

/**
 * Lists that are each fine but undo each other where both apply (UniFi → Unify
 * on the whole library, Unify → UniFi on TV/). Every file there would fail its
 * stability check, so the pair is refused on save. Checked per folder a list
 * names, and for output rules per target language, because rules limited to
 * different languages never run on the same file.
 */
function crossListConflicts(sets: readonly CorrectionRuleSet[]): CorrectionIssue[] {
  const live = sets.filter((set) => set.enabled);
  // Every language an output rule is limited to, plus "a language none of them names".
  const languages = [...new Set(live.flatMap((set) => set.rules.flatMap((rule) => rule.languages)))];
  const scopes: Array<{ stage: "source" | "output"; langs: string[] }> = [
    { stage: "source", langs: [] },
    { stage: "output", langs: [] },
    ...languages.map((lang) => ({ stage: "output" as const, langs: [lang] })),
  ];
  const issues = new Map<string, CorrectionIssue>();
  for (const folder of new Set(live.flatMap((set) => set.paths))) {
    for (const { stage, langs } of scopes) {
      const compiled = compileCorrectionsFor(live, folder, stage, langs);
      const names = [...new Set(compiled.map((c) => c.setName))];
      if (names.length < 2) continue;
      for (const { rule } of compiled) {
        if (rule.match === "regex") continue;
        const unstable = [rule.find, rule.replace].some((probe) => {
          if (!probe) return false;
          const once = correctCueText(probe, compiled).text;
          return totalCorrections(correctCueText(once, compiled).counts) > 0;
        });
        if (unstable) {
          const issue: CorrectionIssue = { code: "listsConflict", lists: names, folder, find: rule.find };
          issues.set(describeCorrectionIssue(issue), issue);
          break;
        }
      }
    }
  }
  return [...issues.values()];
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
        if (rule.except?.includes(relativePath)) return false;
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
/**
 * A term worth telling the translator to keep: a name, not an ordinary word.
 * Capitals, digits or a script without case (UniFi, U7 Pro, 優比快) say name;
 * an all-lowercase Latin word (a typo fix like teh → the) does not, and pinning
 * it would tell the LLM to leave an English word untranslated.
 */
function looksLikeName(term: string): boolean {
  return /[\p{Lu}\p{N}]/u.test(term) || /[\p{L}]/u.test(term.replace(/[\p{Ll}\p{Lu}\p{Lt}]/gu, ""));
}

export function correctionGlossaryTerms(rules: readonly CompiledCorrection[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const { rule } of rules) {
    const term = rule.replace.trim();
    if (rule.match === "regex" || !term || !looksLikeName(term)) continue;
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

// ── Fixing files already in the library (/api/corrections/scan and /apply) ──

export interface ScanMatch {
  path: string;
  /** MEDIA_DIR-relative. */
  relative: string;
  kind: "source" | "output";
  count: number;
  samples: Array<{ before: string; after: string }>;
  /** Set when the file matches but cannot be rewritten (not UTF-8, does not parse). */
  error?: string;
  /** Source: the finished translations a re-translate would redo, with the tokens they took last time. */
  jobs: Array<{ id: number; langCode: string; tokens: number }>;
}

export interface ScanReport {
  matches: ScanMatch[];
  filesScanned: number;
  totalMatches: number;
  /** More files than MAX_FILES were in scope; only the first were read. */
  truncated: boolean;
}

export interface ApplyReport {
  results: Array<{ path: string; total: number; error?: string }>;
  totalFixed: number;
  /** Translation jobs queued again because their source changed. */
  retranslated: number;
}
