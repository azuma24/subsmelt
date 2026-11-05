import {
  normalizeCorrectionPath,
  pathInCorrectionScope,
  type CorrectionRule,
  type CorrectionRuleSet,
} from "../../../shared/corrections";

/**
 * UI helpers for correction lists. The stored shape is still a rule set that
 * names its folders (src/shared/corrections.ts); the UI calls a set a "list"
 * and lets a folder switch lists on, which is the same data seen from the
 * folder's side.
 */

export const createId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function newRule(find = "", replace = ""): CorrectionRule {
  return {
    id: createId(),
    find,
    replace,
    stage: "source",
    match: "word",
    caseSensitive: true,
    languages: [],
    enabled: true,
  };
}

export function newList(name: string, folder?: string): CorrectionRuleSet {
  return { id: createId(), name, enabled: true, paths: folder === undefined ? [] : [folder], rules: [] };
}

/** A list as it applies to one folder. */
export interface FolderList {
  list: CorrectionRuleSet;
  /** On for this folder itself (and so switchable here). */
  direct: boolean;
  /** The nearest ancestor folder it is on for, when it reaches this folder only through one. */
  inheritedFrom: string | null;
}

/** Every list and how it reaches `folder` (media-relative, "" for the root): lists that do come first. */
export function listsForFolder(lists: readonly CorrectionRuleSet[], folder: string): FolderList[] {
  const rows = lists.map((list): FolderList => {
    const direct = list.paths.includes(folder);
    const ancestors = list.paths
      .filter((p) => p !== folder && pathInCorrectionScope(folder, p))
      .sort((a, b) => b.length - a.length);
    return { list, direct, inheritedFrom: direct ? null : (ancestors[0] ?? null) };
  });
  const applies = (row: FolderList) => row.list.enabled && (row.direct || row.inheritedFrom !== null);
  return [...rows.filter(applies), ...rows.filter((row) => !applies(row))];
}

/** Switch a list on or off for exactly this folder. */
export function setListForFolder(
  lists: readonly CorrectionRuleSet[],
  listId: string,
  folder: string,
  on: boolean,
): CorrectionRuleSet[] {
  return lists.map((list) => {
    if (list.id !== listId) return list;
    const paths = list.paths.filter((p) => p !== folder);
    return { ...list, paths: on ? [...paths, folder] : paths };
  });
}

const QUICK_SEPARATORS = /\s*(?:→|->|=>|\t)\s*/;

/**
 * Parse pasted or typed pairs, one per line: `Ubiquity → Ubiquiti`,
 * `Ubiquity -> Ubiquiti`, `Ubiquity => Ubiquiti` or tab-separated (a
 * spreadsheet column pair). Lines without a separator are ignored.
 */
export function parseQuickAdd(text: string): Array<{ find: string; replace: string }> {
  const pairs: Array<{ find: string; replace: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(QUICK_SEPARATORS);
    if (parts.length !== 2) continue;
    const find = parts[0].trim();
    const replace = parts[1].trim();
    if (find) pairs.push({ find, replace });
  }
  return pairs;
}

function lowerFirst(text: string): string {
  const [first = "", ...rest] = Array.from(text);
  return first.toLowerCase() + rest.join("");
}

/**
 * After `Unify → Unifi`, offer `unify → unifi`: whole-word rules match case,
 * so a capitalised term needs its lowercase twin. Null when there is nothing
 * to offer (not capitalised, case-insensitive, or the twin exists).
 */
export function lowercaseTwin(
  rule: CorrectionRule,
  rules: readonly CorrectionRule[],
): { find: string; replace: string } | null {
  if (rule.match === "regex" || !rule.caseSensitive || !rule.find) return null;
  const find = lowerFirst(rule.find);
  if (find === rule.find) return null;
  if (rules.some((r) => r.find === find)) return null;
  return { find, replace: lowerFirst(rule.replace) };
}

/** Non-default options, as the short tags a collapsed rule row shows. */
export function ruleTags(
  rule: CorrectionRule,
): Array<"output" | "both" | "phrase" | "regex" | "anyCase" | "langs" | "except"> {
  const tags: Array<"output" | "both" | "phrase" | "regex" | "anyCase" | "langs" | "except"> = [];
  if (rule.stage === "output" || rule.stage === "both") tags.push(rule.stage);
  if (rule.match === "phrase" || rule.match === "regex") tags.push(rule.match);
  if (!rule.caseSensitive) tags.push("anyCase");
  if (rule.stage !== "source" && rule.languages.length) tags.push("langs");
  if (rule.except?.length) tags.push("except");
  return tags;
}

/** A library item's folder in the form lists store it. */
export function listFolder(folder: string): string {
  return normalizeCorrectionPath(folder) ?? "";
}

/** A folder and every folder above it, nearest first, ending with the whole library (""). */
export function ancestorFolders(folder: string): string[] {
  const parts = listFolder(folder).split("/").filter(Boolean);
  const out: string[] = [];
  for (let n = parts.length; n > 0; n--) out.push(parts.slice(0, n).join("/"));
  out.push("");
  return out;
}

/** Scripts written without spaces between words, where a whole-word match would never fire. */
const NO_SPACE_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Whole word for spaced scripts; anywhere for Chinese, Japanese, Thai and the like. */
export function defaultMatchFor(find: string): CorrectionRule["match"] {
  return NO_SPACE_SCRIPTS.test(find) ? "phrase" : "word";
}

/**
 * Add `rule` to the list `listId` (or to a new list named `newName`) and
 * make sure that list is on for `folder`. The rule replaces one in that list
 * with the same find text and options, so fixing a word twice does not
 * leave two rules for it.
 */
export function addRuleForFolder(
  lists: readonly CorrectionRuleSet[],
  folder: string,
  listId: string | null,
  rule: CorrectionRule,
  newName: string,
): CorrectionRuleSet[] {
  const same = (r: CorrectionRule) =>
    r.find === rule.find && r.match === rule.match && r.caseSensitive === rule.caseSensitive && r.stage === rule.stage;
  if (listId === null || !lists.some((list) => list.id === listId)) {
    return [...lists, { ...newList(newName, folder), rules: [rule] }];
  }
  return lists.map((list) => {
    if (list.id !== listId) return list;
    // Replacing a twin keeps the files it was already told to leave alone.
    const merged = (r: CorrectionRule): CorrectionRule => {
      const except = [...new Set([...(r.except ?? []), ...(rule.except ?? [])])];
      return { ...rule, id: r.id, ...(except.length ? { except } : {}) };
    };
    const rules = list.rules.some(same) ? list.rules.map((r) => (same(r) ? merged(r) : r)) : [...list.rules, rule];
    return { ...list, rules, paths: list.paths.includes(folder) ? list.paths : [...list.paths, folder] };
  });
}
