import fs from "node:fs";
import path from "node:path";
import { getSetting, getTasks, preferredChinese, setSetting, type TranslationTask } from "./config.js";
import { createJob, listJobPathsAndStatuses, listJobTaskStatuses, resetJob } from "./db.js";
import { parseRules, resolveDirectoryRule } from "./directory-rules.js";
import { fileLangCodes } from "./language-codes.js";
import { logger } from "./logger.js";
import { errorMessage } from "./errors.js";
import { removeJobPartialOutput } from "./job-output.js";
import { loadTitleSidecar, getTitle, pruneTitleSidecarQueued, type TitleSidecar } from "./translator/title-sidecar.js";
import { findAnyCase, stripLangSuffix, taskOutputName, taskOutputNames } from "./output-names.js";
import { caseKey, mediaRelativeDir, normalizeMediaSubfolder, resolveMediaSubfolder } from "./media-paths.js";
import { createSubtitleIntakeDecider, intakeCompanionStem, matchSubtitleIntakeRule } from "./subtitle-intake.js";
import { parseSubtitleIntakeRules, type SubtitleIntakeDecision } from "../shared/subtitle-intake.js";
import { hasAutomaticTranslationRestrictions, isAutomaticTranslationAllowed } from "./transcription/review-gate.js";
import type { FolderCounts, FolderNode, ScannedFile, ScanResult, ScanTaskState } from "../shared/scan.js";

export const MEDIA_DIR = process.env.MEDIA_DIR || "/media";

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
    if (job.status === "done" || job.status === "skipped") counts.completeJobs += 1;
    map.set(relativeDir, counts);
  }
  return map;
}

/**
 * Every file under `dir`, in directory order. Asynchronous and sequential:
 * one readdir at a time keeps the walk off the event loop (a large NAS used
 * to freeze every request and SSE heartbeat for the whole scan) while keeping
 * the order a synchronous walk produced, which the tie-breaks below rely on.
 */
async function walkDir(
  dir: string,
  results: string[],
  directories: Set<string>,
  errors: { path: string; message: string }[],
  skippedFolders: string[],
  depth = 999,
): Promise<void> {
  const relativePath = path.relative(path.resolve(MEDIA_DIR), path.resolve(dir)).split(path.sep).join("/");
  if (pathIsInScope(relativePath, skippedFolders)) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    errors.push({ path: dir, message: errorMessage(error) });
    return;
  }
  directories.add(dir);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip hidden
    if (entry.isSymbolicLink()) continue; // skip symlinks to avoid cycles
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) await walkDir(fullPath, results, directories, errors, skippedFolders, depth - 1);
    } else {
      results.push(fullPath);
    }
  }
}

/** Modification times for many files at once, a few stats in flight; unreadable files map to null. */
async function statMtimes(files: string[], concurrency = 16): Promise<Map<string, number | null>> {
  const mtimes = new Map<string, number | null>();
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const stats = await Promise.all(
      batch.map((file) =>
        fs.promises.stat(file).then(
          (s) => s.mtimeMs,
          () => null,
        ),
      ),
    );
    batch.forEach((file, j) => {
      mtimes.set(file, stats[j]);
    });
  }
  return mtimes;
}

async function buildFolderNode(
  dir: string,
  root: string,
  videoExts: Set<string>,
  subtitleExts: Set<string>,
  jobCountsByFolder: Map<string, FolderCounts>,
): Promise<FolderNode> {
  const relativePath = path.relative(root, dir).split(path.sep).join("/");
  const normalizedPath = relativePath === "." ? "" : relativePath;
  let directCounts = createEmptyCounts();
  const children: FolderNode[] = [];

  try {
    const entries = (await fs.promises.readdir(dir, { withFileTypes: true })).filter(
      (entry) => !entry.name.startsWith("."),
    );
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (videoExts.has(ext)) directCounts.videos += 1;
      if (subtitleExts.has(ext)) directCounts.subtitles += 1;
    }

    const folders = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of folders) {
      children.push(
        await buildFolderNode(path.join(dir, entry.name), root, videoExts, subtitleExts, jobCountsByFolder),
      );
    }
  } catch {
    // skip inaccessible directories
  }

  directCounts = addCounts(directCounts, jobCountsByFolder.get(normalizedPath) || createEmptyCounts());
  const counts = children.reduce((total, child) => addCounts(total, child.counts), directCounts);

  return {
    name: path.basename(dir),
    path: normalizedPath,
    counts,
    children,
  };
}

export async function listFolderTree(): Promise<FolderNode> {
  const mediaRoot = path.resolve(MEDIA_DIR);
  const videoExts = parseExtensionSetting(getSetting("video_extensions"));
  const subtitleExts = parseExtensionSetting(getSetting("subtitle_extensions"));
  const jobCountsByFolder = getJobCountsByFolder();
  const root = await buildFolderNode(mediaRoot, mediaRoot, videoExts, subtitleExts, jobCountsByFolder);
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
  return folders.some((folder) => relativePath === folder || relativePath.startsWith(`${folder}/`));
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
        .flatMap((task) =>
          taskOutputNames(srtPath, task).map((name) => caseKey(path.join(path.dirname(srtPath), name))),
        )
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

export async function scanFolder(
  createJobs = true,
  options?: { intake: "preview" | "run"; transcriptionAvailable: boolean },
): Promise<ScanResult> {
  const videoExts = getSetting("video_extensions")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  const subExts = getSetting("subtitle_extensions")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  const tasks = getTasks();
  const enabledTasks = tasks.filter((t: TranslationTask) => t.enabled);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  // Per-directory translation control.
  const directoryRules = parseRules(getSetting("directory_rules") || "[]");
  const globalTranslateWithoutVideo = getSetting("translate_without_video") === "on";
  const mediaRoot = path.resolve(MEDIA_DIR);
  // Tasks used for output-file detection: every task, enabled or not. A
  // disabled task's translation is still a translation, and read as a source
  // it would show its video twice and translate the same language again.
  const outputDetectTasks = [
    ...enabledTasks,
    ...tasks.filter((t: TranslationTask) => !enabledTasks.some((e: TranslationTask) => e.id === t.id)),
  ];

  if (!fs.existsSync(MEDIA_DIR)) {
    throw new Error(`Media directory does not exist: ${MEDIA_DIR}. Check your Docker volume mounts.`);
  }

  const scanMode = getSetting("scan_mode") || "recursive";
  const selectedFolders = parseFolderSetting(getSetting("scan_folders") || "");
  const excludedFolders = parseFolderSetting(getSetting("scan_exclude_folders") || "");

  let allFiles: string[] = [];
  const walkedDirs = new Set<string>();
  const errors: { path: string; message: string }[] = [];
  const skippedFolders = [...excludedFolders, youtubeFolder()].filter((folder): folder is string => Boolean(folder));
  if (scanMode === "root_only") {
    // Only files directly in MEDIA_DIR, no subdirectories
    await walkDir(MEDIA_DIR, allFiles, walkedDirs, errors, skippedFolders, 0);
  } else if (scanMode === "selected") {
    // Scan only selected subdirectories. Root files are covered by root_only mode.
    for (const folder of selectedFolders) {
      if (pathIsInScope(folder, skippedFolders)) continue;
      const folderPath = resolveMediaSubfolder(folder, MEDIA_DIR);
      if (folderPath) await walkDir(folderPath, allFiles, walkedDirs, errors, skippedFolders);
      else
        errors.push({
          path: path.join(MEDIA_DIR, folder),
          message: "Cannot resolve selected folder safely; check for a dangling link or a path outside the media root",
        });
    }
  } else {
    // Default: full recursive scan
    await walkDir(MEDIA_DIR, allFiles, walkedDirs, errors, skippedFolders);
  }
  allFiles = Array.from(new Set(allFiles)).filter((file) => {
    const relativePath = path.relative(path.resolve(MEDIA_DIR), path.resolve(file)).split(path.sep).join("/");
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
  if (createJobs && videoFiles.length > 0 && getSetting("media_scanned") !== "1") {
    setSetting("media_scanned", "1");
  }

  // Find subtitles
  const srtFiles = allFiles.filter((f) => subExts.includes(path.extname(f).toLowerCase()));

  const taskOutputs = findTaskOutputs(srtFiles, outputDetectTasks);

  const matchingVideo = (srtPath: string): string | null => {
    const ext = path.extname(srtPath);
    const stem = path.basename(srtPath, ext);
    const dir = path.dirname(srtPath);
    return videoIndex.get(`${dir}/${stem}`) ?? videoIndex.get(`${dir}/${stripLangSuffix(stem)}`) ?? null;
  };
  const sourcesShortestFirst = srtFiles
    .filter((srtPath) => !taskOutputs.has(caseKey(srtPath)))
    .sort((a, b) => path.basename(a).length - path.basename(b).length);
  const intakeDecisions = new Map<string, SubtitleIntakeDecision>();
  if (options) {
    const rules = parseSubtitleIntakeRules(getSetting("subtitle_intake_rules")).sort(
      (a, b) => b.path.length - a.path.length,
    );
    if (rules.length > 0) {
      const decideSubtitleIntake = createSubtitleIntakeDecider();
      const sourcesByVideo = new Map<string, string[]>();
      const sidecarsByVideo = new Map<string, string[]>();
      const sourcesAdded = new Set(sourcesShortestFirst);
      const formats = new Set([...subExts, ".srt", ".ass", ".ssa", ".vtt", ".idx", ".sub", ".sup"]);
      for (const source of srtFiles) {
        const video = matchingVideo(source);
        if (video) {
          const sources = sourcesByVideo.get(video) ?? [];
          sources.push(source);
          sourcesByVideo.set(video, sources);
        }
      }
      for (const file of allFiles) {
        if (!formats.has(path.extname(file).toLowerCase())) continue;
        const video = matchingVideo(file) ?? videoIndex.get(`${path.dirname(file)}/${intakeCompanionStem(file)}`);
        if (video) {
          const sidecars = sidecarsByVideo.get(video) ?? [];
          sidecars.push(file);
          sidecarsByVideo.set(video, sidecars);
        }
      }
      // The shared FFprobe gate also bounds simultaneous preview and run requests.
      for (let start = 0; start < videoFiles.length; start += 3) {
        const decisions = await Promise.all(
          videoFiles.slice(start, start + 3).map(async (video) => {
            const relativeFolder = path
              .relative(mediaRoot, path.resolve(path.dirname(video)))
              .split(path.sep)
              .join("/");
            const rule = matchSubtitleIntakeRule(relativeFolder, rules);
            if (!rule) return null;
            const decision = await decideSubtitleIntake({
              video,
              sources: sourcesByVideo.get(video) ?? [],
              allSidecars: sidecarsByVideo.get(video) ?? [],
              rule,
              preferredChinese: preferredChinese(),
              run: options.intake === "run",
              transcriptionAvailable: options.transcriptionAvailable && errors.length === 0,
            });
            return { video, decision };
          }),
        );
        for (const planned of decisions) {
          if (!planned) continue;
          const { video, decision } = planned;
          intakeDecisions.set(video, decision);
          if (!decision.file) continue;
          const source = path.join(path.dirname(video), decision.file);
          if (!sourcesAdded.has(source)) {
            sourcesShortestFirst.push(source);
            sourcesAdded.add(source);
          }
          if (decision.action === "imported") {
            srtFiles.push(source);
            scannedFiles.set(caseKey(source), source);
          }
        }
      }
      sourcesShortestFirst.sort((a, b) => path.basename(a).length - path.basename(b).length);
    }
  }

  const sourcePlans = new Map<string, { videoPath: string | null; effectiveTasks: TranslationTask[] }>();
  for (const srtPath of sourcesShortestFirst) {
    const videoPath = matchingVideo(srtPath);
    const relDir = path
      .relative(mediaRoot, path.resolve(path.dirname(srtPath)))
      .split(path.sep)
      .join("/");
    const resolved = resolveDirectoryRule(relDir, directoryRules, globalTranslateWithoutVideo);
    const effectiveTasks: TranslationTask[] = [];
    const intake = videoPath ? intakeDecisions.get(videoPath) : undefined;
    const chosen = !intake || intake.file === path.basename(srtPath);
    if (chosen && (videoPath || resolved.translateWithoutVideo)) {
      effectiveTasks.push(...enabledTasks);
      for (const id of resolved.extraTaskIds) {
        const task = tasksById.get(id);
        if (task && !effectiveTasks.some((entry) => entry.id === id)) effectiveTasks.push(task);
      }
    }
    sourcePlans.set(srtPath, { videoPath, effectiveTasks });
  }
  // Only source subtitles without a video need their own modification time.
  const orphanMtimes = await statMtimes(sourcesShortestFirst.filter((file) => !sourcePlans.get(file)?.videoPath));

  // Group by video file
  // Key: videoPath or "orphan:{srtPath}"
  const grouped = new Map<string, ScannedFile>();

  // Pre-populate video entries (even those without subtitles). One stat per
  // video, a few at a time, instead of a blocking stat each.
  const videoMtimes = await statMtimes(videoFiles);
  for (const vf of videoFiles) {
    grouped.set(vf, {
      videoPath: vf,
      videoName: path.basename(vf),
      videoMtime: videoMtimes.get(vf) ?? null,
      subtitles: [],
      ...(intakeDecisions.has(vf) ? { intake: intakeDecisions.get(vf) } : {}),
    });
  }

  // Review can start during a filesystem await. Apply the current gate at
  // the synchronous job planning boundary, before choosing output owners.
  if (hasAutomaticTranslationRestrictions()) {
    for (const [subtitlePath, source] of sourcePlans) {
      source.effectiveTasks = source.effectiveTasks.filter((task) =>
        isAutomaticTranslationAllowed(subtitlePath, source.videoPath ?? undefined, task.id),
      );
    }
  }

  // Read jobs after the filesystem awaits. A concurrent scan or one-off
  // translation may have queued a job since the walk began.
  const jobRows = listJobTaskStatuses();
  const jobTasks = new Map(jobRows.map((job) => [`${job.srt_path}\u0000${job.task_id}`, job]));
  const jobbedTasksBySource = new Map<string, TranslationTask[]>();
  const outputOwners = new Map<string, { srtPath: string; taskId: number }>();
  for (const job of jobRows) {
    const task = tasksById.get(job.task_id);
    if (task) {
      const jobbed = jobbedTasksBySource.get(job.srt_path) ?? [];
      jobbed.push(task);
      jobbedTasksBySource.set(job.srt_path, jobbed);
    }
    const key = caseKey(job.output_path);
    if (job.owns_output || (!outputOwners.has(key) && (job.status === "pending" || job.status === "translating"))) {
      outputOwners.set(key, { srtPath: job.srt_path, taskId: job.task_id });
    }
  }
  // Existing jobs keep their destinations. Of new sources competing for a
  // destination, the shortest eligible name wins, then the first eligible task.
  for (const [srtPath, { effectiveTasks }] of sourcePlans) {
    for (const task of effectiveTasks) {
      const key = caseKey(path.join(path.dirname(srtPath), taskOutputName(srtPath, task)));
      if (!outputOwners.has(key)) outputOwners.set(key, { srtPath, taskId: task.id });
    }
  }

  let newJobs = 0;

  // Per-folder title sidecar cache for this scan, plus the media bases still
  // present per folder (used to prune stale sidecar entries afterwards).
  const titleSidecars = new Map<string, TitleSidecar>();
  const titleBasesByDir = new Map<string, Set<string>>();
  for (const dir of walkedDirs) {
    const relativePath = path.relative(mediaRoot, path.resolve(dir)).split(path.sep).join("/");
    if (!pathIsInScope(relativePath, skippedFolders)) titleBasesByDir.set(dir, new Set());
  }
  // Include every video and subtitle, including videos without subtitles and
  // subtitles classified as task outputs, before considering any deletion.
  for (const file of [...videoFiles, ...srtFiles]) {
    const ext = path.extname(file);
    const stem = path.basename(file, ext);
    const bases = titleBasesByDir.get(path.dirname(file));
    bases?.add(stem);
    if (subExts.includes(ext.toLowerCase())) bases?.add(stripLangSuffix(stem));
  }
  const sidecarFor = (dir: string): TitleSidecar => {
    const cached = titleSidecars.get(dir);
    if (cached) return cached;
    const loaded = loadTitleSidecar(dir);
    titleSidecars.set(dir, loaded);
    return loaded;
  };

  for (const srtPath of srtFiles) {
    const plan = sourcePlans.get(srtPath);
    if (!plan) continue;
    const { videoPath, effectiveTasks } = plan;

    const ext = path.extname(srtPath);
    const dir = path.dirname(srtPath);
    const stem = path.basename(srtPath, ext);
    const baseStem = stripLangSuffix(stem);

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
      grouped.set(groupKey, {
        videoPath,
        videoName: videoPath ? path.basename(videoPath) : null,
        videoMtime: videoPath ? (videoMtimes.get(videoPath) ?? null) : null,
        subtitleMtime: videoPath ? undefined : (orphanMtimes.get(srtPath) ?? null),
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
    const titleBase = videoPath ? path.basename(videoPath, path.extname(videoPath)) : baseStem;
    const dirBases = titleBasesByDir.get(dir) ?? new Set<string>();
    titleBasesByDir.set(dir, dirBases.add(titleBase));

    // For each shown task, compute output and check status
    for (const task of shownTasks) {
      // The name this task writes, or the file already there under an older spelling.
      const writtenPath = path.join(dir, taskOutputName(srtPath, task));
      const existingPath =
        taskOutputNames(srtPath, task)
          .map((name) => scannedPath(path.join(dir, name)))
          .find(Boolean) ?? null;
      const outputOwner = outputOwners.get(caseKey(writtenPath));
      const ownsOutput = !outputOwner || (outputOwner.srtPath === srtPath && outputOwner.taskId === task.id);
      const existingOwner = existingPath ? outputOwners.get(caseKey(existingPath)) : undefined;
      const outputExists = existingPath !== null && (!existingOwner || existingOwner.taskId === task.id);
      const outputPath = outputExists ? existingPath : writtenPath;
      const outputName = path.basename(outputPath);

      // Check existing job
      const existingJob = jobTasks.get(`${srtPath}\u0000${task.id}`);
      // A finished job whose output is gone from disk (the person deleted a bad
      // translation) is translated again, as a new job would be: the job row
      // must not outlive the file it stands for.
      const outputDeleted =
        existingJob !== undefined &&
        (existingJob.status === "done" || existingJob.status === "skipped") &&
        !outputExists &&
        ownsOutput &&
        effectiveTasks.some((t: TranslationTask) => t.id === task.id) &&
        (scannedPath(existingJob.output_path) ?? findAnyCase(existingJob.output_path)) === null;

      let status: ScanTaskState;
      let jobId: number | null = null;

      if (existingJob && !outputDeleted) {
        status = existingJob.status as "done" | "pending" | "translating" | "error" | "skipped";
        jobId = existingJob.id;
      } else if (outputExists) {
        status = "skipped";
      } else if (!ownsOutput && outputOwner) {
        status = "skipped";
        if (createJobs) {
          logger.info(
            "scan",
            `Skipped ${path.basename(srtPath)} (task #${task.id}): ${path.basename(outputOwner.srtPath)} (task #${outputOwner.taskId}) already translates to ${outputName}`,
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
          const previousOutput = existingJob.output_path;
          if (resetJob(existingJob.id, outputPath) > 0) {
            if (previousOutput !== outputPath) removeJobPartialOutput(previousOutput);
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
      `Scan ${errors.length ? "incomplete" : "complete"}: ${srtFiles.length} subtitle files, ${videoFiles.length} videos, ${newJobs} new jobs created`,
    );
  }

  // Drop sidecar titles for media that no longer exists in scanned folders.
  // Queued behind the per-directory title lock so a prune never interleaves
  // with an in-flight title write from the queue. Never prune a preview or a
  // scan that could not read every directory in its scope.
  if (createJobs && errors.length === 0 && getSetting("title_sidecar") === "1") {
    for (const [dir, bases] of titleBasesByDir) {
      void pruneTitleSidecarQueued(dir, () => {
        // The walk may predate a title write. Re-read while holding the title
        // lock so newly created media and its title cannot be pruned.
        try {
          const current = new Set(bases);
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name.startsWith(".")) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (!videoExts.includes(ext) && !subExts.includes(ext)) continue;
            const stem = path.basename(entry.name, path.extname(entry.name));
            current.add(stem);
            if (subExts.includes(ext)) current.add(stripLangSuffix(stem));
          }
          return current;
        } catch (e) {
          logger.warn("scan", `Title sidecar prune skipped: ${dir} — ${errorMessage(e) || e}`);
          return null;
        }
      }).catch((e) => {
        logger.warn("scan", `Title sidecar prune failed: ${dir} — ${errorMessage(e) || e}`);
      });
    }
  }

  return { files, newJobs, totalSubtitles: srtFiles.length, complete: errors.length === 0, errors };
}
