import fs from "node:fs";
import path from "node:path";
import { getSetting, getTasks } from "./config.js";
import { createJob, getJobBySrtAndTask, getJobs } from "./db.js";
import { logger } from "./logger.js";

export const MEDIA_DIR = process.env.MEDIA_DIR || "/media";

const LANG_SUFFIXES = new Set([
  "en", "eng", "english",
  "ja", "jp", "jpn", "japanese",
  "zh", "chi", "cht", "chs", "zht", "zhs", "chinese",
  "ko", "kor", "korean",
  "fr", "fra", "french",
  "de", "deu", "german",
  "es", "spa", "spanish",
  "pt", "por", "portuguese",
  "it", "ita", "italian",
  "ru", "rus", "russian",
  "ar", "ara", "arabic",
  "th", "tha", "thai",
  "vi", "vie", "vietnamese",
]);

export interface FolderNode {
  name: string;
  path: string;
  counts: FolderCounts;
  children: FolderNode[];
}

export interface FolderCounts {
  videos: number;
  subtitles: number;
  pendingJobs: number;
  completeJobs: number;
  errorJobs: number;
}

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
  return new Set(raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

function mediaRelativeDir(filePath: string): string | null {
  const mediaRoot = path.resolve(MEDIA_DIR);
  const resolved = path.resolve(filePath);
  if (resolved !== mediaRoot && !resolved.startsWith(`${mediaRoot}${path.sep}`)) return null;
  const relativeDir = path.relative(mediaRoot, path.dirname(resolved)).split(path.sep).join("/");
  return relativeDir === "." ? "" : relativeDir;
}

function getJobCountsByFolder(): Map<string, FolderCounts> {
  const map = new Map<string, FolderCounts>();
  for (const job of getJobs() as any[]) {
    const relativeDir = mediaRelativeDir(job.srt_path);
    if (relativeDir === null) continue;

    const counts = map.get(relativeDir) || createEmptyCounts();
    if (job.status === "pending") counts.pendingJobs += 1;
    if (job.status === "error") counts.errorJobs += 1;
    if (job.status === "done" || job.status === "skipped") counts.completeJobs += 1;
    map.set(relativeDir, counts);
  }
  return map;
}

function walkDir(dir: string, results: string[] = [], depth = 999): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip hidden
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
  jobCountsByFolder: Map<string, FolderCounts>
): FolderNode {
  const relativePath = path.relative(root, dir).split(path.sep).join("/");
  const normalizedPath = relativePath === "." ? "" : relativePath;
  let directCounts = createEmptyCounts();
  let children: FolderNode[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (videoExts.has(ext)) directCounts.videos += 1;
      if (subtitleExts.has(ext)) directCounts.subtitles += 1;
    }

    children = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => buildFolderNode(path.join(dir, entry.name), root, videoExts, subtitleExts, jobCountsByFolder));
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

function buildFolderTree(
  dir: string,
  root: string,
  videoExts: Set<string>,
  subtitleExts: Set<string>,
  jobCountsByFolder: Map<string, FolderCounts>
): FolderNode[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => buildFolderNode(path.join(dir, entry.name), root, videoExts, subtitleExts, jobCountsByFolder));
  } catch {
    // skip inaccessible directories
    return [];
  }
}

function flattenFolderTree(nodes: FolderNode[], results: string[] = []): string[] {
  for (const node of nodes) {
    results.push(node.path);
    flattenFolderTree(node.children, results);
  }
  return results;
}

function normalizeMediaSubfolder(folder: string): string | null {
  const trimmed = folder.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.includes("\0") || trimmed.startsWith("/")) return null;

  const normalized = path.posix.normalize(trimmed);
  if (!normalized || normalized === "." || normalized.startsWith("../")) return null;
  return normalized;
}

function resolveMediaSubfolder(folder: string): string | null {
  const normalized = normalizeMediaSubfolder(folder);
  if (!normalized) return null;

  const mediaRoot = path.resolve(MEDIA_DIR);
  const fullPath = path.resolve(mediaRoot, ...normalized.split("/"));
  if (fullPath === mediaRoot || !fullPath.startsWith(`${mediaRoot}${path.sep}`)) return null;
  return path.join(MEDIA_DIR, ...normalized.split("/"));
}

/** List all subdirectories of MEDIA_DIR as relative paths */
export function listSubfolders(): string[] {
  return flattenFolderTree(listFolderTree().children).sort((a, b) => a.localeCompare(b));
}

export function listFolderTree(): FolderNode {
  const mediaRoot = path.resolve(MEDIA_DIR);
  const videoExts = parseExtensionSetting(getSetting("video_extensions"));
  const subtitleExts = parseExtensionSetting(getSetting("subtitle_extensions"));
  const jobCountsByFolder = getJobCountsByFolder();
  const root = buildFolderNode(mediaRoot, mediaRoot, videoExts, subtitleExts, jobCountsByFolder);
  return {
    name: path.basename(mediaRoot) || mediaRoot,
    path: "",
    counts: root.counts,
    children: root.children,
  };
}

function parseFolderSetting(raw: string): string[] {
  return Array.from(new Set(
    raw
      .split(",")
      .map((f) => normalizeMediaSubfolder(f))
      .filter((f): f is string => Boolean(f))
  ));
}

function pathIsInScope(relativePath: string, folders: string[]): boolean {
  return folders.some((folder) => relativePath === folder || relativePath.startsWith(`${folder}/`));
}

/** Strip known language suffix from a subtitle stem: "Movie.en" → "Movie" */
function stripLangSuffix(stem: string): string {
  const parts = stem.split(".");
  if (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    if (LANG_SUFFIXES.has(last)) {
      return parts.slice(0, -1).join(".");
    }
  }
  return stem;
}

/** Apply output pattern substitution */
function applyPattern(
  pattern: string,
  baseStem: string,
  langCode: string,
  ext: string
): string {
  return pattern
    .replace(/\{\{name\}\}/g, baseStem)
    .replace(/\{\{lang_code\}\}/g, langCode)
    .replace(/\{\{ext\}\}/g, ext);
}

export interface ScannedFile {
  videoPath: string | null;
  videoName: string | null;
  subtitles: {
    srtPath: string;
    srtName: string;
    tasks: {
      taskId: number;
      targetLang: string;
      langCode: string;
      outputPath: string;
      outputName: string;
      status: "done" | "pending" | "translating" | "error" | "skipped" | "new";
      jobId: number | null;
    }[];
  }[];
}

export interface ScanResult {
  files: ScannedFile[];
  newJobs: number;
  totalSubtitles: number;
}

export function scanFolder(createJobs = true): ScanResult {
  const videoExts = getSetting("video_extensions")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  const subExts = getSetting("subtitle_extensions")
    .split(",")
    .map((e) => e.trim().toLowerCase());
  const tasks = getTasks() as any[];
  const enabledTasks = tasks.filter((t: any) => t.enabled);

  if (!fs.existsSync(MEDIA_DIR)) {
    throw new Error(`Media directory does not exist: ${MEDIA_DIR}. Check your Docker volume mounts.`);
  }

  const scanMode = getSetting("scan_mode") || "recursive";
  const selectedFolders = parseFolderSetting(getSetting("scan_folders") || "");
  const excludedFolders = parseFolderSetting(getSetting("scan_exclude_folders") || "");

  let allFiles: string[];
  if (scanMode === "root_only") {
    // Only files directly in MEDIA_DIR, no subdirectories
    allFiles = walkDir(MEDIA_DIR, [], 0);
  } else if (scanMode === "selected") {
    // Scan only selected subdirectories. Root files are covered by root_only mode.
    allFiles = [];
    for (const folder of selectedFolders) {
      const folderPath = resolveMediaSubfolder(folder);
      if (folderPath && fs.existsSync(folderPath)) walkDir(folderPath, allFiles);
    }
  } else {
    // Default: full recursive scan
    allFiles = walkDir(MEDIA_DIR);
  }
  allFiles = Array.from(new Set(allFiles)).filter((file) => {
    if (excludedFolders.length === 0) return true;
    const relativePath = path.relative(path.resolve(MEDIA_DIR), path.resolve(file)).split(path.sep).join("/");
    return !pathIsInScope(relativePath, excludedFolders);
  });

  // Index videos by (dir, stem)
  const videoIndex = new Map<string, string>();
  const videoFiles: string[] = [];
  for (const f of allFiles) {
    const ext = path.extname(f).toLowerCase();
    if (videoExts.includes(ext)) {
      const dir = path.dirname(f);
      const stem = path.basename(f, ext);
      videoIndex.set(`${dir}/${stem}`, f);
      videoFiles.push(f);
    }
  }

  // Find subtitles
  const srtFiles = allFiles.filter((f) =>
    subExts.includes(path.extname(f).toLowerCase())
  );

  // Group by video file
  // Key: videoPath or "orphan:{srtPath}"
  const grouped = new Map<string, ScannedFile>();

  // Pre-populate video entries (even those without subtitles)
  for (const vf of videoFiles) {
    grouped.set(vf, {
      videoPath: vf,
      videoName: path.basename(vf),
      subtitles: [],
    });
  }

  let newJobs = 0;

  for (const srtPath of srtFiles) {
    const ext = path.extname(srtPath);
    const extNoDot = ext.slice(1).toLowerCase();
    const dir = path.dirname(srtPath);
    const stem = path.basename(srtPath, ext);
    const baseStem = stripLangSuffix(stem);

    // Check if this IS an output file from any task
    // Strategy 1: pattern-shape match (fast)
    const isOutputFile = enabledTasks.some((task: any) => {
      // Check against every possible base stem in the same directory
      // by testing if removing the task suffix yields a valid source file
      const testPattern = applyPattern(task.output_pattern, "TEST_MARKER", task.lang_code, extNoDot);
      const outputStem = path.basename(testPattern, path.extname(testPattern));
      const suffix = outputStem.replace("TEST_MARKER", "");
      if (!suffix) return false;
      if (stem.endsWith(suffix)) return true;
      // Strategy 2: check if this file's name exactly matches what any srt in the same dir would produce
      const possibleBaseStem = suffix ? stem.slice(0, stem.length - suffix.length) : stem;
      if (!possibleBaseStem) return false;
      const candidateSource = path.join(dir, possibleBaseStem + ext);
      return fs.existsSync(candidateSource);
    });
    if (isOutputFile) continue;

    // Match to video
    let videoPath: string | null = null;
    for (const tryName of [stem, baseStem]) {
      const match = videoIndex.get(`${dir}/${tryName}`);
      if (match) {
        videoPath = match;
        break;
      }
    }

    const groupKey = videoPath || `orphan:${srtPath}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        videoPath,
        videoName: videoPath ? path.basename(videoPath) : null,
        subtitles: [],
      });
    }

    const subtitleEntry: ScannedFile["subtitles"][0] = {
      srtPath,
      srtName: path.basename(srtPath),
      tasks: [],
    };

    // For each enabled task, compute output and check status
    for (const task of enabledTasks) {
      const outputName = applyPattern(task.output_pattern, baseStem, task.lang_code, extNoDot);
      const outputPath = path.join(dir, outputName);
      const outputExists = fs.existsSync(outputPath);

      // Check existing job
      const existingJob = getJobBySrtAndTask(srtPath, task.id) as any;

      let status: "done" | "pending" | "translating" | "error" | "skipped" | "new";
      let jobId: number | null = null;

      if (existingJob) {
        status = existingJob.status;
        jobId = existingJob.id;
      } else if (outputExists) {
        status = "skipped";
      } else {
        status = "new";
      }

      // Create job if needed
      if (status === "new") {
        if (createJobs) {
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
        } else {
          newJobs++;
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
      `Scan complete: ${srtFiles.length} subtitle files, ${videoFiles.length} videos, ${newJobs} new jobs created`
    );
  }

  return { files, newJobs, totalSubtitles: srtFiles.length };
}
