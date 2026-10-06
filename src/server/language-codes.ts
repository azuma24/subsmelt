/**
 * One language code per language in every file SubSmelt writes.
 *
 * A subtitle's language suffix is the three-letter ISO 639-2 code: eng, kor,
 * jpn, fra. The user's preferred Chinese is "chi"; the other script is "cht"
 * (Traditional) or "chs" (Simplified). Brazilian and European Portuguese have
 * no three-letter code and keep pt-BR and pt-PT. Other spellings (en, zh-TW,
 * english) are still read, so files written with them keep counting.
 */
import type { TranslationTask } from "./config.js";
import {
  isKnownLanguage,
  languageFileAliases,
  languageFileCode,
  languageKey,
  preferredChineseKey,
  taskLanguageKey,
  type PreferredChinese,
} from "./youtube/subtitle-routes.js";

export type { PreferredChinese };

type TaskLanguage = Pick<TranslationTask, "target_lang" | "lang_code"> & { former_lang_codes?: string[] };

/** The standard code for any spelling of a language; a code the table does not know is kept as typed. */
export function standardLangCode(code: string, preferred: PreferredChinese = "zh-TW"): string {
  const key = languageKey(code);
  return isKnownLanguage(key) ? languageFileCode(key, preferred) : code.trim();
}

/** A task's standard code, read from its language name first ("Traditional Chinese" says more than "chi"). */
export function standardTaskLangCode(
  task: Pick<TranslationTask, "target_lang" | "lang_code">,
  preferred: PreferredChinese = "zh-TW",
): string {
  const key = taskLanguageKey(task);
  return isKnownLanguage(key) ? languageFileCode(key, preferred) : task.lang_code.trim();
}

/** The language a file code names now: "chi" and "zh" are whichever Chinese script is preferred. */
function codeLanguage(key: string, preferred: PreferredChinese): string {
  return key === "zh" ? preferredChineseKey(preferred) : key;
}

/**
 * Every language suffix that marks a file as this task's output: the code it
 * writes first, then the other spellings of its language and the codes it
 * wrote before the standard. A former code that now names another language is
 * dropped: once Simplified is preferred, the "chi" a Traditional task wrote
 * before is Simplified's code, so .chi files count for Simplified only.
 */
export function fileLangCodes(task: TaskLanguage, preferred: PreferredChinese = "zh-TW"): string[] {
  const key = taskLanguageKey(task);
  const language = codeLanguage(key, preferred);
  const former = (task.former_lang_codes ?? []).filter((code) => {
    const named = codeLanguage(languageKey(code), preferred);
    return !isKnownLanguage(named) || named === language;
  });
  const codes = [task.lang_code, ...languageFileAliases(key), ...former];
  // "chi" and "zh" name no script: they are the preferred one.
  if (key === preferredChineseKey(preferred)) codes.push(...languageFileAliases("zh"));
  return [...new Set(codes)];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Moves a task to its standard code, remembering the old one so files already
 * written with it still count. A pattern that spelled the old code out
 * ("{{name}}.eng.srt") gets the placeholder instead. A task whose standard
 * code another task already uses is left alone.
 */
export function standardizeTask<T extends TranslationTask>(
  task: T,
  others: readonly TranslationTask[],
  preferred: PreferredChinese = "zh-TW",
): T {
  const next = standardTaskLangCode(task, preferred);
  if (next === task.lang_code || others.some((o) => o.id !== task.id && o.lang_code === next)) return task;
  const spelledOut = new RegExp(`\\.${escapeRegExp(task.lang_code)}\\.`, "i");
  const output_pattern = task.output_pattern.includes("{{lang_code}}")
    ? task.output_pattern
    : task.output_pattern.replace(spelledOut, ".{{lang_code}}.");
  const former_lang_codes = [...new Set([...(task.former_lang_codes ?? []), task.lang_code])];
  return { ...task, lang_code: next, output_pattern, former_lang_codes };
}

/**
 * Every task on its standard code. Repeats until nothing moves, because a
 * switch of the preferred Chinese swaps two codes: Simplified can take "chi"
 * only after Traditional has moved off it to "cht".
 */
export function standardizeTasks<T extends TranslationTask>(
  tasks: readonly T[],
  preferred: PreferredChinese = "zh-TW",
): T[] {
  let current = [...tasks];
  for (let pass = 0; pass <= tasks.length; pass++) {
    const next = current.reduce<T[]>(
      (done, task, i) => [...done, standardizeTask(task, [...done, ...current.slice(i + 1)], preferred)],
      [],
    );
    if (next.every((task, i) => task === current[i])) return next;
    current = next;
  }
  return current;
}
