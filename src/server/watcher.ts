import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs";
import { getSetting } from "./config.js";
import { MEDIA_DIR } from "./scanner.js";
import { scanFolder } from "./scanner.js";
import { runQueueSafely } from "./queue.js";
import { broadcast } from "./sse.js";
import { logger } from "./logger.js";

let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 5000; // Wait 5s after last file change before scanning

function getSubtitleExts(): string[] {
  return getSetting("subtitle_extensions")
    .split(",")
    .map((e) => e.trim().toLowerCase());
}

function handleFileChange(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const subExts = getSubtitleExts();

  // Only react to new subtitle files
  if (!subExts.includes(ext)) return;

  logger.info("scan", `File watcher detected: ${path.basename(filePath)}`);

  // Debounce — wait for batch of files to settle before scanning
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void (async () => {
      try {
        const result = await scanFolder(true);
        // Same announcement as an HTTP scan, so the UI's caches (including the
        // sticky media_scanned flag the checklists read) stay current.
        broadcast("scan:complete", { newJobs: result.newJobs, total: result.totalSubtitles });
        if (result.newJobs > 0) {
          logger.info("scan", `Watcher: ${result.newJobs} new jobs queued`);
          if (getSetting("auto_translate") === "1") runQueueSafely();
        }
      } catch (e: any) {
        logger.error("scan", `Watcher scan error: ${e.message}`);
      }
    })();
  }, DEBOUNCE_MS);
}

export function startWatcher() {
  stopWatcher();

  if (!fs.existsSync(MEDIA_DIR)) {
    logger.warn("system", `File watcher: ${MEDIA_DIR} does not exist`);
    return;
  }

  watcher = chokidar.watch(MEDIA_DIR, {
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  watcher.on("add", handleFileChange);
  watcher.on("change", handleFileChange);

  watcher.on("error", (error: any) => {
    logger.error("system", `File watcher error: ${error.message}`);
  });

  logger.info("system", `File watcher started on ${MEDIA_DIR}`);
}

export function stopWatcher() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
    logger.info("system", "File watcher stopped");
  }
}

export function isWatcherRunning(): boolean {
  return watcher !== null;
}

/** Restart watcher with current folder config */
export function restartWatcher() {
  const enabled = getSetting("watch_enabled") === "1";
  if (enabled) {
    startWatcher();
  } else {
    stopWatcher();
  }
}
