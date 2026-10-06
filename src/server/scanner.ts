import fs from "node:fs";
import path from "node:path";
import { getSetting, getTasks, preferredChinese, setSetting, type TranslationTask } from "./config.js";
import {
  createJob,
  listJobPathsAndStatuses,
  listJobTaskStatuses,
  resetJob,
} from "./db.js";
import { parseRules, resolveDirectoryRule } from "./directory-rules.js";
import { fileLangCodes } from "./language-codes.js";
import { allLanguageFileAliases } from "./youtube/subtitle-routes.js";
import { logger } from "./logger.js";
import {
  loadTitleSidecar,
  getTitle,
  pruneTitleSidecarQueued,
  type TitleSidecar,
} from "./translator/title-sidecar.js";
import {
  mediaRelativeDir,
  normalizeMediaSubfolder,
  resolveMediaSubfolder,
} from "./media-paths.js";
import type { FolderCounts, FolderNode, ScannedFile, ScanResult, ScanTaskState } from "../shared/scan.js";

export const MEDIA_DIR = process.env.MEDIA_DIR || "/media";

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

export type { FolderCounts, FolderNode, ScannedFile, ScanResult };

function createEmptyCounts(): FolderCounts {
  return {
    videos: 0,
    subtitles: 0,
    pendingJobs: 0,
    completeJobs: 0,
    errorJobs: 0,
  };
}

function addCounts(a: FolderCounts, b: FolderCounts): FolderCounts {
  return {
    videos: a.videos + b.videos,
    subtitles: a.subtitles + b.subtitles,
    pendingJobs: a.pendingJobs + b.pendingJobs,
    completeJobs: a.completeJobs + b.completeJobs,
    errorJobs: a.errorJobs + b.errorJobs,
  };
}

function parseExtensionSetting(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

function getJobCountsByFolder(): Map<string, FolderCounts> {
  const map = new Map<string, FolderCounts>();
  for (const job of listJobPathsAndStatuses()) {
    const relativeDir = mediaRelativeDir(job.srt_path, MEDIA_DIR);
    if (relativeDir === null) continue;

    const counts = map.get(relativeDir) || createEmptyCounts();
    if (job.status === "pending") counts.pendingJobs += 1;
    if (job.status === "error") counts.errorJobs += 1;
    if (job.status === "done" || job.status === "skipped")
      counts.completeJobs += 1;
    map.set(relativeDir, counts);
  }
  return map;
}

function walkDir(dir: string, results: string[] = [], depth = 999): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip hidden
      if (entry.isSymbolicLink()) continue; // skip symlinks to avoid cycles
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walkDir(fullPath, results, depth - 1);
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // skip inaccessible directories
  }
  return results;
}

function buildFolderNode(
  dir: string,
  root: string,
  videoExts: Set<string>,
  subtitleExts: Set<string>,
  jobCountsByFolder: Map<string, FolderCounts>,
): FolderNode {
  const relativePath = path.relative(root, dir).split(path.sep).join("/");
  const normalizedPath = relativePath === "." ? "" : relativePath;
  let directCounts = createEmptyCounts();
  let children: FolderNode[] = [];

  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."));
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (videoExts.has(ext)) directCounts.videos += 1;
      if (subtitleExts.has(ext)) directCounts.subtitles += 1;
    }

    children = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) =>
        buildFolderNode(
          path.join(dir, entry.name),
          root,
          videoExts,
          subtitleExts,
          jobCountsByFolder,
        ),
      );
  } catch {
    // skip inaccessible directories
  }

  directCounts = addCounts(
    directCounts,
    jobCountsByFolder.get(normalizedPath) || createEmptyCounts(),
  );
  const counts = children.reduce(
    (total, child) => addCounts(total, child.counts),
    directCounts,
  );

  return {
    name: path.basename(dir),
    path: normalizedPath,
    counts,
    children,
  };
}

function buildFolderTree(
  dir: string,
  root: string,
  videoExts: Set<string>,
  subtitleExts: Set<string>,
  jobCountsByFolder: Map<string, FolderCounts>,
): FolderNode[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) =>
        buildFolderNode(
          path.join(dir, entry.name),
          root,
          videoExts,
          subtitleExts,
          jobCountsByFolder,
        ),
      );
  } catch {
    // skip inaccessible directories
    return [];
  }
}

export function listFolderTree(): FolderNode {
  const mediaRoot = path.resolve(MEDIA_DIR);
  const videoExts = parseExtensionSetting(getSetting("video_extensions"));
  const subtitleExts = parseExtensionSetting(getSetting("subtitle_extensions"));
  const jobCountsByFolder = getJobCountsByFolder();
  const root = buildFolderNode(
    mediaRoot,
    mediaRoot,
    videoExts,
    subtitleExts,
    jobCountsByFolder,
  );
  return {
    name: path.basename(mediaRoot) || mediaRoot,
    path: "",
    counts: root.counts,
    children: root.children,
  };
}

/** Folder list setting: a JSON array, so names may contain commas, or the legacy comma-separated list. */
export function parseFolderSetting(raw: string): string[] {
  let folders: unknown[] = raw.split(",");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) folders = parsed;
  } catch {
    // Not JSON: keep the legacy comma split.
  }
  return Array.from(
    new Set(
      folders
        .filter((f): f is string => typeof f === "string")
        .map((f) => normalizeMediaSubfolder(f))
        .filter((f): f is string => Boolean(f)),
    ),
  );
}

function pathIsInScope(relativePath: string, folders: string[]): boolean {
  return folders.some(
    (folder) =>
      relativePath === folder || relativePath.startsWith(`${folder}/`),
  );
}

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
  return langAt > 0 && isLangSuffix(parts[langAt])
    ? parts.slice(0, langAt).join(".")
    : stem;
}

/** Apply output pattern substitution */
function applyPattern(
  pattern: string,
  baseStem: string,
  langCode: string,
  ext: string,
): string {
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
  return outputNameFor(
    stripLangSuffix(path.basename(srtPath, ext)),
    task,
    ext.slice(1),
  );
}

/**
 * Every name that counts as `task`'s output for `srtPath`: the one it writes
 * first, then the same name with the other spellings of its language, so a
 * "Movie.eng.srt" written before the language-code standard still counts for
 * an English task that now writes "Movie.en.srt".
 */
export function taskOutputNames(srtPath: string, task: Pick<TranslationTask, "output_pattern" | "lang_code" | "target_lang" | "former_lang_codes">): string[] {
  const names = fileLangCodes(task, preferredChinese()).map((code) => taskOutputName(srtPath, { ...task, lang_code: code }));
  return [...new Set(names)];
}

/**
 * Where a job should write: the task's standard name when `outputPath` is an
 * older spelling of it (a job queued before the language-code standard),
 * otherwise `outputPath` unchanged.
 */
export function standardOutputFor(srtPath: string, outputPath: string, task: Parameters<typeof taskOutputNames>[1]): string {
  const dir = path.dirname(srtPath);
  const [written, ...older] = taskOutputNames(srtPath, task).map((name) => path.join(dir, name));
  // Every code the task wrote before, including one that now names another
  // language: a Traditional job queued for .chi must not write Simplified's .chi.
  const former = (task.former_lang_codes ?? []).map((code) => path.join(dir, taskOutputName(srtPath, { ...task, lang_code: code })));
  return [...older, ...former].some((p) => caseKey(p) === caseKey(outputPath)) ? written : outputPath;
}

/** The output of `task` for `srtPath` already on disk in any spelling, matched case-insensitively. */
export function existingTaskOutput(srtPath: string, task: Parameters<typeof taskOutputNames>[1]): string | null {
  const dir = path.dirname(srtPath);
  return taskOutputNames(srtPath, task).map((name) => findAnyCase(path.join(dir, name))).find(Boolean) ?? null;
}

/** A path compared ignoring case in its file name only: folders named "Show" and "show" stay apart. */
function caseKey(file: string): string {
  return path.join(path.dirname(file), path.basename(file).toLowerCase());
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

/** Modification time for ordering sources; a file that cannot be read sorts last. */
function mtimeOf(file: string): number {
  return fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Number.POSITIVE_INFINITY;
}

/**
 * The subtitles that are task outputs (by caseKey), not sources. A subtitle is
 * an output only when a sibling subtitle would produce exactly its name; a
 * source whose name merely looks like an output is still a source.
 *
 * Two subtitles can each be the other's output: with English and Chinese
 * tasks, Movie.eng.srt translates to Movie.chi.srt and back. A translation is
 * written after its source, so in such a pair only the older file produces the
 * newer one (equal times: the shorter, then the first name). That keeps exactly
 * one source in any group of mutual translations.
 */
function findTaskOutputs(srtFiles: string[], tasks: TranslationTask[]): Set<string> {
  const producedBy = new Map<string, Set<string>>();
  for (const srtPath of srtFiles) {
    const outputs = new Set(
      tasks
        .flatMap((task) => taskOutputNames(srtPath, task).map((name) => caseKey(path.join(path.dirname(srtPath), name))))
        .filter((output) => output !== caseKey(srtPath)),
    );
    producedBy.set(caseKey(srtPath), outputs);
  }
  const mtimes = new Map<string, number>();
  const mtime = (file: string) => {
    if (!mtimes.has(file)) mtimes.set(file, mtimeOf(file));
    return mtimes.get(file)!;
  };
  const olderThan = (a: string, b: string) =>
    mtime(a) - mtime(b) || path.basename(a).length - path.basename(b).length || (a < b ? -1 : 1);

  const outputs = new Set<string>();
  const byKey = new Map(srtFiles.map((f) => [caseKey(f), f]));
  for (const source of srtFiles) {
    for (const output of producedBy.get(caseKey(source)) ?? []) {
      const outputFile = byKey.get(output);
      if (!outputFile) continue;
      const mutual = producedBy.get(output)?.has(caseKey(source)) ?? false;
      if (!mutual || olderThan(source, outputFile) < 0) outputs.add(output);
    }
  }
  return outputs;
}

/**
 * The YouTube download folder, relative to MEDIA_DIR. Its playlists create
 * exactly the jobs they ask for, so a library scan leaves it alone.
 */
function youtubeFolder(): string | null {
  return normalizeMediaSubfolder(getSetting("youtube_download_dir"));
}

export function scanFolder(createJobs = true): ScanResult {
  const videoExts = getSetting("video_extensions")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  const subExts = getSetting("subtitle_extensions")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  const tasks = getTasks();
  const enabledTasks = tasks.filter((t: TranslationTask) => t.enabled);

  // Per-directory translation control.
  const directoryRules = parseRules(getSetting("directory_rules") || "[]");
  const globalTranslateWithoutVideo =
    getSetting("translate_without_video") === "on";
  const mediaRoot = path.resolve(MEDIA_DIR);
  // Job states for every (source subtitle, task) pair, loaded once instead of
  // one SQLite query per pair.
  const jobRows = listJobTaskStatuses();
  const jobTasks = new Map(jobRows.map((job) => [`${job.srt_path}\u0000${job.task_id}`, job]));
  // Tasks each source already has a job for, which includes one-off
  // translations on tasks no scan applies.
  const jobbedTasksBySource = new Map<string, TranslationTask[]>();
  for (const job of jobRows) {
    const task = tasks.find((t: TranslationTask) => t.id === job.task_id);
    if (!task) continue;
    jobbedTasksBySource.set(job.srt_path, [...(jobbedTasksBySource.get(job.srt_path) ?? []), task]);
  }
  // Tasks used for output-file detection: every task, enabled or not. A
  // disabled task's translation is still a translation, and read as a source
  // it would show its video twice and translate the same language again.
  const outputDetectTasks = [
    ...enabledTasks,
    ...tasks.filter((t: TranslationTask) => !enabledTasks.some((e: TranslationTask) => e.id === t.id)),
  ];

  if (!fs.existsSync(MEDIA_DIR)) {
    throw new Error(
      `Media directory does not exist: ${MEDIA_DIR}. Check your Docker volume mounts.`,
    );
  }

  const scanMode = getSetting("scan_mode") || "recursive";
  const selectedFolders = parseFolderSetting(getSetting("scan_folders") || "");
  const excludedFolders = parseFolderSetting(
    getSetting("scan_exclude_folders") || "",
  );

  let allFiles: string[];
  if (scanMode === "root_only") {
    // Only files directly in MEDIA_DIR, no subdirectories
    allFiles = walkDir(MEDIA_DIR, [], 0);
  } else if (scanMode === "selected") {
    // Scan only selected subdirectories. Root files are covered by root_only mode.
    allFiles = [];
    for (const folder of selectedFolders) {
      const folderPath = resolveMediaSubfolder(folder, MEDIA_DIR);
      if (folderPath && fs.existsSync(folderPath))
        walkDir(folderPath, allFiles);
    }
  } else {
    // Default: full recursive scan
    allFiles = walkDir(MEDIA_DIR);
  }
  const skippedFolders = [...excludedFolders, youtubeFolder()].filter(
    (folder): folder is string => Boolean(folder),
  );
  allFiles = Array.from(new Set(allFiles)).filter((file) => {
    const relativePath = path
      .relative(path.resolve(MEDIA_DIR), path.resolve(file))
      .split(path.sep)
      .join("/");
    return !pathIsInScope(relativePath, skippedFolders);
  });

  // Index videos by (dir, stem)
  const videoIndex = new Map<string, string>();
  const videoFiles: string[] = [];
  // The walk is the truth for what exists: every output file this scan could
  // ask about lives in a walked directory, so membership here answers
  // fs.existsSync without one syscall per subtitle per task.
  // Lower-cased path to the real one: a task's output matches in any case.
  const scannedFiles = new Map(allFiles.map((f) => [caseKey(f), f]));
  const scannedPath = (p: string) => scannedFiles.get(caseKey(p)) ?? null;
  for (const f of allFiles) {
    const ext = path.extname(f);
    if (videoExts.includes(ext.toLowerCase())) {
      const dir = path.dirname(f);
      // The real extension, not the lower-cased one: "Movie.MKV" has the stem "Movie".
      const stem = path.basename(f, ext);
      videoIndex.set(`${dir}/${stem}`, f);
      videoFiles.push(f);
    }
  }

  // "Media discovered" is a sticky fact, not a live one: the setup checklists
  // read this flag, and the jobs table they used before empties on every
  // clear/delete — a rescan then creates no jobs (outputs exist), so a
  // jobs-based step could never clear again. One guarded write, ever.
  if (videoFiles.length > 0 && getSetting("media_scanned") !== "1") {
    setSetting("media_scanned", "1");
  }

  // Find subtitles
  const srtFiles = allFiles.filter((f) =>
    subExts.includes(path.extname(f).toLowerCase()),
  );

  const taskOutputs = findTaskOutputs(srtFiles, outputDetectTasks);

  // Show.srt and Show.eng.srt both translate to Show.zh.srt, and two jobs on one
  // output would share its .part file. The shortest source name owns each
  // output, so a source without a language suffix wins.
  const outputOwners = new Map<string, string>();
  const sourcesShortestFirst = srtFiles
    .filter((srtPath) => !taskOutputs.has(caseKey(srtPath)))
    .sort((a, b) => path.basename(a).length - path.basename(b).length);
  for (const srtPath of sourcesShortestFirst) {
    for (const task of outputDetectTasks) {
      const outputPath = path.join(
        path.dirname(srtPath),
        taskOutputName(srtPath, task),
      );
      if (!outputOwners.has(outputPath)) outputOwners.set(outputPath, srtPath);
    }
  }

  // Group by video file
  // Key: videoPath or "orphan:{srtPath}"
  const grouped = new Map<string, ScannedFile>();

  // Pre-populate video entries (even those without subtitles)
  for (const vf of videoFiles) {
    let videoMtime: number | null = null;
    try {
      videoMtime = fs.statSync(vf).mtimeMs;
    } catch {
      /* skip on stat error */
    }
    grouped.set(vf, {
      videoPath: vf,
      videoName: path.basename(vf),
      videoMtime,
      subtitles: [],
    });
  }

  let newJobs = 0;

  // Per-folder title sidecar cache for this scan, plus the media bases still
  // present per folder (used to prune stale sidecar entries afterwards).
  const titleSidecars = new Map<string, TitleSidecar>();
  const titleBasesByDir = new Map<string, Set<string>>();
  const sidecarFor = (dir: string): TitleSidecar => {
    const cached = titleSidecars.get(dir);
    if (cached) return cached;
    const loaded = loadTitleSidecar(dir);
    titleSidecars.set(dir, loaded);
    return loaded;
  };

  for (const srtPath of srtFiles) {
    if (taskOutputs.has(caseKey(srtPath))) continue;

    const ext = path.extname(srtPath);
    const dir = path.dirname(srtPath);
    const stem = path.basename(srtPath, ext);
    const baseStem = stripLangSuffix(stem);

    // Match to video
    let videoPath: string | null = null;
    for (const tryName of [stem, baseStem]) {
      const match = videoIndex.get(`${dir}/${tryName}`);
      if (match) {
        videoPath = match;
        break;
      }
    }

    // Resolve directory rule for this subtitle's folder.
    const relDir = path
      .relative(mediaRoot, path.resolve(dir))
      .split(path.sep)
      .join("/");
    const resolved = resolveDirectoryRule(
      relDir,
      directoryRules,
      globalTranslateWithoutVideo,
    );

    // Orphan gate: subtitles with no companion video only translate where enabled.
    const gated = videoPath === null && !resolved.translateWithoutVideo;

    // Effective tasks = global enabled tasks ∪ the rule's extra tasks (additive union).
    // Rule-attached tasks apply even if globally disabled, as long as the task exists.
    const effectiveTasks = gated ? [] : [...enabledTasks];
    for (const tid of gated ? [] : resolved.extraTaskIds) {
      if (effectiveTasks.some((t: TranslationTask) => t.id === tid)) continue;
      const extra = tasks.find((t: TranslationTask) => t.id === tid);
      if (extra) effectiveTasks.push(extra);
    }
    // Shown tasks add the ones this subtitle already has a job for. Those
    // always take their status from the job, so they never create one. A
    // subtitle with no shown task is still listed: the Library must know the
    // video has one, or it offers to transcribe over it.
    const shownTasks = [
      ...effectiveTasks,
      ...(jobbedTasksBySource.get(srtPath) ?? []).filter(
        (t) => !effectiveTasks.some((e: TranslationTask) => e.id === t.id),
      ),
    ];

    const groupKey = videoPath || `orphan:${srtPath}`;
    if (!grouped.has(groupKey)) {
      let videoMtime: number | null = null;
      if (videoPath) {
        try {
          videoMtime = fs.statSync(videoPath).mtimeMs;
        } catch {
          /* skip on stat error */
        }
      }
      grouped.set(groupKey, {
        videoPath,
        videoName: videoPath ? path.basename(videoPath) : null,
        videoMtime,
        subtitles: [],
      });
    }

    const subtitleEntry: ScannedFile["subtitles"][0] = {
      srtPath,
      srtName: path.basename(srtPath),
      tasks: [],
    };

    // Same base rule as the queue's title step: video stem when present,
    // else the language-suffix-stripped subtitle stem.
    const titleBase = videoPath
      ? path.basename(videoPath, path.extname(videoPath))
      : baseStem;
    const dirBases = titleBasesByDir.get(dir) ?? new Set<string>();
    titleBasesByDir.set(dir, dirBases.add(titleBase));

    // For each shown task, compute output and check status
    for (const task of shownTasks) {
      // The name this task writes, or the file already there under an older spelling.
      const writtenPath = path.join(dir, taskOutputName(srtPath, task));
      const existingPath = taskOutputNames(srtPath, task).map((name) => scannedPath(path.join(dir, name))).find(Boolean) ?? null;
      const outputPath = existingPath ?? writtenPath;
      const outputName = path.basename(outputPath);
      const outputExists = existingPath !== null;
      const outputOwner = outputOwners.get(writtenPath) ?? srtPath;

      // Check existing job
      const existingJob = jobTasks.get(`${srtPath}\u0000${task.id}`);
      // A finished job whose output is gone from disk (the person deleted a bad
      // translation) is translated again, as a new job would be: the job row
      // must not outlive the file it stands for.
      const outputDeleted =
        existingJob !== undefined &&
        (existingJob.status === "done" || existingJob.status === "skipped") &&
        !outputExists &&
        outputOwner === srtPath &&
        effectiveTasks.some((t: TranslationTask) => t.id === task.id) &&
        (scannedPath(existingJob.output_path) ?? findAnyCase(existingJob.output_path)) === null;

      let status: ScanTaskState;
      let jobId: number | null = null;

      if (existingJob && !outputDeleted) {
        status = existingJob.status as
          | "done"
          | "pending"
          | "translating"
          | "error"
          | "skipped";
        jobId = existingJob.id;
      } else if (outputExists) {
        status = "skipped";
      } else if (outputOwner !== srtPath) {
        status = "skipped";
        if (createJobs) {
          logger.info(
            "scan",
            `Skipped ${path.basename(srtPath)}: ${path.basename(outputOwner)} already translates to ${outputName}`,
          );
        }
      } else {
        status = "new";
      }

      // Create job if needed
      if (status === "new") {
        if (!createJobs) {
          newJobs++;
        } else if (existingJob) {
          if (resetJob(existingJob.id, outputPath) > 0) {
            logger.info("scan", `Job #${existingJob.id} queued again: ${outputName} no longer exists`, existingJob.id);
            newJobs++;
            jobId = existingJob.id;
            status = "pending";
          }
        } else {
          const result = createJob({
            task_id: task.id,
            srt_path: srtPath,
            output_path: outputPath,
            video_path: videoPath,
            status: "pending",
          });
          if (result.changes > 0) {
            newJobs++;
            jobId = Number(result.lastInsertRowid);
            status = "pending";
          }
        }
      }

      subtitleEntry.tasks.push({
        taskId: task.id,
        targetLang: task.target_lang,
        langCode: task.lang_code,
        outputPath,
        outputName,
        status,
        jobId,
        outputExists,
        translatedTitle:
          // Titles saved under an older spelling of the language still show.
          fileLangCodes(task, preferredChinese())
            .map((code) => getTitle(sidecarFor(path.dirname(outputPath)), titleBase, code))
            .find(Boolean) ?? null,
      });
    }

    grouped.get(groupKey)!.subtitles.push(subtitleEntry);
  }

  const files = Array.from(grouped.values()).sort((a, b) => {
    const aName = a.videoName || "";
    const bName = b.videoName || "";
    return aName.localeCompare(bName);
  });

  if (createJobs) {
    logger.info(
      "scan",
      `Scan complete: ${srtFiles.length} subtitle files, ${videoFiles.length} videos, ${newJobs} new jobs created`,
    );
  }

  // Drop sidecar titles for media that no longer exists in scanned folders.
  // Queued behind the per-directory title lock so a prune never interleaves
  // with an in-flight title write from the queue (fire-and-forget: scan
  // results don't depend on prune completion).
  if (getSetting("title_sidecar") === "1") {
    for (const [dir, bases] of titleBasesByDir)
      void pruneTitleSidecarQueued(dir, bases);
  }

  return { files, newJobs, totalSubtitles: srtFiles.length };
}
