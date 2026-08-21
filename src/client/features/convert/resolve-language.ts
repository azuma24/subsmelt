import { AMBIGUOUS_INPUTS, LANGUAGES, findLanguage, type LanguageEntry } from "./language-table";

export type LanguageResolution =
  | { status: "resolved"; language: LanguageEntry }
  | { status: "ambiguous"; options: LanguageEntry[] }
  | { status: "unknown"; suggestions: LanguageEntry[] };

const MAX_SUGGESTIONS = 5;
const TYPO_DISTANCE_MAX = 2;

function normalize(input: string): string {
  return input.trim().toLowerCase();
}

function matchTerms(entry: LanguageEntry): string[] {
  return [entry.code, entry.englishName, entry.nativeName, ...entry.aliases].map(normalize);
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Resolve free-text target-language input to a canonical entry.
 * Ambiguous inputs ("Chinese", "zh", "中文", bare "Portuguese") come back as a
 * choice — never a silent default. Unknown input comes back with close-match
 * suggestions for a "did you mean" hint.
 */
export function resolveTargetLanguage(input: string): LanguageResolution {
  const needle = normalize(input);
  if (!needle) return { status: "unknown", suggestions: [] };

  const ambiguous = AMBIGUOUS_INPUTS.get(needle);
  if (ambiguous) {
    const options = ambiguous
      .map((code) => findLanguage(code))
      .filter((l): l is LanguageEntry => Boolean(l));
    return { status: "ambiguous", options };
  }

  const exact = LANGUAGES.find((l) => matchTerms(l).includes(needle));
  if (exact) return { status: "resolved", language: exact };

  const scored = LANGUAGES
    .map((l) => ({ l, d: Math.min(...matchTerms(l).map((term) => editDistance(needle, term))) }))
    .filter(({ d }) => d <= TYPO_DISTANCE_MAX)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ l }) => l);
  return { status: "unknown", suggestions: scored };
}

/** Autocomplete: prefix matches first, then substring matches, table order within each. */
export function suggestLanguages(input: string, limit: number = 8): LanguageEntry[] {
  const needle = normalize(input);
  if (!needle) return [];
  const prefix: LanguageEntry[] = [];
  const substring: LanguageEntry[] = [];
  for (const entry of LANGUAGES) {
    const terms = matchTerms(entry);
    if (terms.some((term) => term.startsWith(needle))) prefix.push(entry);
    else if (terms.some((term) => term.includes(needle))) substring.push(entry);
  }
  return [...prefix, ...substring].slice(0, limit);
}
