import fs from "node:fs";
import path from "node:path";
import { getSetting, getTasks } from "./config.js";
import { createJob, getJobBySrtAndTask } from "./db.js";
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

/** List immediate subdirectories of MEDIA_DIR */
export function listSubfolders(): string[] {
  try {
    return fs.readdirSync(MEDIA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
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
  const scanFolders = getSetting("scan_folders") || "";
  const selectedFolders = scanFolders
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  let allFiles: string[];
  if (scanMode === "root_only") {
    // Only files directly in MEDIA_DIR, no subdirectories
    allFiles = walkDir(MEDIA_DIR, [], 0);
  } else if (scanMode === "selected" && selectedFolders.length > 0) {
    // Scan only selected subdirectories + root files
    allFiles = walkDir(MEDIA_DIR, [], 0); // root files
    for (const folder of selectedFolders) {
      const folderPath = path.join(MEDIA_DIR, folder);
      if (fs.existsSync(folderPath)) walkDir(folderPath, allFiles);
    }
  } else {
    // Default: full recursive scan
    allFiles = walkDir(MEDIA_DIR);
  }

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
      if (createJobs && status === "new") {
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
