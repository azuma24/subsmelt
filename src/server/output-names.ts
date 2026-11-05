/**
 * How subtitle files are named: reading a language suffix off a file name, and
 * building the output name a translation task writes. The scanner, the queue,
 * the file-translation route and the YouTube pipeline all name files here.
 */
import fs from "node:fs";
import path from "node:path";
import { preferredChinese, type TranslationTask } from "./config.js";
import { fileLangCodes } from "./language-codes.js";
import { caseKey } from "./media-paths.js";
import { allLanguageFileAliases } from "./youtube/subtitle-routes.js";

const LANG_SUFFIXES = new Set([
  "en",
  "eng",
  "english",
  "ja",
  "jp",
  "jpn",
  "japanese",
  "zh",
  "chi",
  "cht",
  "chs",
  "zht",
  "zhs",
  "chinese",
  "ko",
  "kor",
  "korean",
  "fr",
  "fra",
  "french",
  "de",
  "deu",
  "german",
  "es",
  "spa",
  "spanish",
  "pt",
  "por",
  "portuguese",
  "it",
  "ita",
  "italian",
  "ru",
  "rus",
  "russian",
  "ar",
  "ara",
  "arabic",
  "th",
  "tha",
  "thai",
  "vi",
  "vie",
  "vietnamese",
]);

// Plus every code and name in the shared language table, so each code a task
// writes (sv, uk, zh-TW, ...) is read back as a language.
for (const alias of allLanguageFileAliases()) LANG_SUFFIXES.add(alias.toLowerCase());
const FLAG_SUFFIXES = new Set(["sdh", "forced", "cc", "hi"]);

/**
 * A known language code, optionally with script or region subtags: "en",
 * "zh-TW", "zh-Hant", "es-419", "zh-Hant-TW". A two-letter code counts only
 * in lower case or with a subtag: an upper- or title-case pair at the end of a
 * name is a word or a country more often than a language ("Episode.VI",
 * "Stephen.Kings.It", "The.Office.UK"). Three-letter codes and names count in
 * any case ("Movie.ENG.srt").
 */
function isLangSuffix(token: string): boolean {
  const [base, ...subtags] = token.split("-");
  if (!/^[a-z]+$/i.test(base) || !LANG_SUFFIXES.has(base.toLowerCase())) return false;
  if (subtags.length > 2 || !subtags.every((tag) => /^(?:[a-z]{2,4}|\d{3})$/i.test(tag))) return false;
  const twoLetterInCaps = base.length === 2 && base !== base.toLowerCase();
  // "ZH-TW" is a language; "De-Luxe" is not.
  if (twoLetterInCaps) return subtags.length > 0 && base === base.toUpperCase();
  return true;
}

/** Strip a trailing language suffix and one flag after it: "Movie.en", "Movie.zh-TW", "Movie.en.sdh" → "Movie" */
export function stripLangSuffix(stem: string): string {
  const parts = stem.split(".");
  const last = parts.length - 1;
  // A flag follows a language ("Movie.en.hi"); alone, "hi" is Hindi's code.
  const flagged = FLAG_SUFFIXES.has(parts[last].toLowerCase()) && last > 1 && isLangSuffix(parts[last - 1]);
  const langAt = flagged ? last - 1 : last;
  return langAt > 0 && isLangSuffix(parts[langAt]) ? parts.slice(0, langAt).join(".") : stem;
}

/** Apply output pattern substitution */
function applyPattern(pattern: string, baseStem: string, langCode: string, ext: string): string {
  // Replacer functions: a string replacement reads "$$" or "$&" in a file name as a pattern.
  return pattern
    .replace(/\{\{name\}\}/g, () => baseStem)
    .replace(/\{\{lang_code\}\}/g, () => langCode)
    .replace(/\{\{ext\}\}/g, () => ext);
}

/** Output file name that `task` gives a subtitle whose name without its language is `baseStem`. */
export function outputNameFor(
  baseStem: string,
  task: { output_pattern: string; lang_code: string },
  ext: string,
): string {
  return applyPattern(task.output_pattern, baseStem, task.lang_code, ext.toLowerCase());
}

/** Output file name, relative to the subtitle's folder, that `task` translates `srtPath` into. */
export function taskOutputName(srtPath: string, task: Pick<TranslationTask, "output_pattern" | "lang_code">): string {
  const ext = path.extname(srtPath);
  return outputNameFor(stripLangSuffix(path.basename(srtPath, ext)), task, ext.slice(1));
}

/**
 * Every name that counts as `task`'s output for `srtPath`: the one it writes
 * first, then the same name with the other spellings of its language, so a
 * "Movie.eng.srt" written before the language-code standard still counts for
 * an English task that now writes "Movie.en.srt".
 */
export function taskOutputNames(
  srtPath: string,
  task: Pick<TranslationTask, "output_pattern" | "lang_code" | "target_lang" | "former_lang_codes">,
): string[] {
  const names = fileLangCodes(task, preferredChinese()).map((code) =>
    taskOutputName(srtPath, { ...task, lang_code: code }),
  );
  return [...new Set(names)];
}

/**
 * Where a job should write: the task's standard name when `outputPath` is an
 * older spelling of it (a job queued before the language-code standard),
 * otherwise `outputPath` unchanged.
 */
export function standardOutputFor(
  srtPath: string,
  outputPath: string,
  task: Parameters<typeof taskOutputNames>[1],
): string {
  const dir = path.dirname(srtPath);
  const [written, ...older] = taskOutputNames(srtPath, task).map((name) => path.join(dir, name));
  // Every code the task wrote before, including one that now names another
  // language: a Traditional job queued for .chi must not write Simplified's .chi.
  const former = (task.former_lang_codes ?? []).map((code) =>
    path.join(dir, taskOutputName(srtPath, { ...task, lang_code: code })),
  );
  return [...older, ...former].some((p) => caseKey(p) === caseKey(outputPath)) ? written : outputPath;
}

/** The output of `task` for `srtPath` already on disk in any spelling, matched case-insensitively. */
export function existingTaskOutput(srtPath: string, task: Parameters<typeof taskOutputNames>[1]): string | null {
  const dir = path.dirname(srtPath);
  return (
    taskOutputNames(srtPath, task)
      .map((name) => findAnyCase(path.join(dir, name)))
      .find(Boolean) ?? null
  );
}

/**
 * The file on disk named like `file` ignoring case, under its real name, or
 * null. "zh-tw" and "zh-TW" are one language; Linux tells them apart and
 * macOS does not, so a lookup must not depend on which one runs.
 */
export function findAnyCase(file: string): string | null {
  try {
    const wanted = path.basename(file).toLowerCase();
    const name = fs.readdirSync(path.dirname(file)).find((entry) => entry.toLowerCase() === wanted);
    return name ? path.join(path.dirname(file), name) : null;
  } catch {
    return null;
  }
}
