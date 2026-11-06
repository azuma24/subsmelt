import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs";
import { getSetting } from "./config.js";
import { MEDIA_DIR } from "./scanner.js";
import { scanAndEnqueue } from "./library-scan.js";
import { logger } from "./logger.js";
import { errorMessage } from "./errors.js";

let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 5000; // Wait 5s after last file change before scanning

function getWatchedExts(): string[] {
  return `${getSetting("subtitle_extensions")},${getSetting("video_extensions")}`
    .split(",")
    .map((e) => e.trim().toLowerCase());
}

function handleFileChange(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const extensions = getWatchedExts();

  // A video can arrive after its subtitle, making an orphan eligible for work.
  if (!ext || !extensions.includes(ext)) return;

  logger.info("scan", `File watcher detected: ${path.basename(filePath)}`);

  // Debounce — wait for batch of files to settle before scanning
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void (async () => {
      try {
        await scanAndEnqueue("watcher");
      } catch (e) {
        logger.error("scan", `Watcher scan error: ${errorMessage(e)}`);
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
    ignored: /(^|[/\\])\../, // ignore dotfiles
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  watcher.on("add", handleFileChange);
  watcher.on("change", handleFileChange);

  watcher.on("error", (error: unknown) => {
    logger.error("system", `File watcher error: ${errorMessage(error)}`);
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
