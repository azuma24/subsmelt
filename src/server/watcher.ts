import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs";
import { getSetting, setSettings } from "./config.js";
import { MEDIA_DIR } from "./scanner.js";
import { VIDEO_SETTLE_MS } from "./embedded-subtitles.js";
import { normalizeMediaSubfolder } from "./media-paths.js";
import { scanAndEnqueue } from "./library-scan.js";
import { logger } from "./logger.js";
import { errorMessage } from "./errors.js";
import { broadcast } from "./sse.js";
import type { WatcherStatus } from "../shared/watcher.js";

const DEBOUNCE_MS = 5_000;
const FILE_RETRY_MS = 10_000;
let fileRetryTimer: ReturnType<typeof setTimeout> | null = null;
const inaccessible = new Set<string>();
let watcher: { source: FSWatcher; controller: AbortController } | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let poll: { timer: ReturnType<typeof setInterval>; minutes: number; controller: AbortController } | null = null;
let pollInProgress = false;
let status: WatcherStatus = { enabled: false, running: false, fileEvents: "off", pollIntervalMinutes: 0 };

export function getWatcherStatus(): WatcherStatus {
  return status;
}

function publishStatus(enabled: boolean, fileEvents: WatcherStatus["fileEvents"]): void {
  const pollIntervalMinutes = poll?.minutes ?? 0;
  if (
    enabled === status.enabled &&
    fileEvents === status.fileEvents &&
    pollIntervalMinutes === status.pollIntervalMinutes
  )
    return;
  status = {
    enabled,
    fileEvents,
    pollIntervalMinutes,
    running: fileEvents === "watching" || pollIntervalMinutes > 0,
  };
  broadcast("watcher:status", status);
}

async function scan(trigger: "watcher" | "poll", signal: AbortSignal): Promise<void> {
  try {
    await scanAndEnqueue(trigger, signal);
  } catch (error) {
    if (!signal.aborted || error !== signal.reason)
      logger.error("scan", `${trigger === "poll" ? "Polling" : "Watcher"} scan error: ${errorMessage(error)}`);
  }
}

function handleFileChange(filePath: string, signal: AbortSignal): void {
  if (signal.aborted) return;
  const ext = path.extname(filePath).toLowerCase();
  const extensions = `${getSetting("subtitle_extensions")},${getSetting("video_extensions")}`
    .split(",")
    .map((value) => value.trim().toLowerCase());
  // A video can arrive after its subtitle, making an orphan eligible for work.
  if (!ext || !extensions.includes(ext)) return;

  logger.info("scan", `File watcher detected: ${path.basename(filePath)}`);
  scheduleFileScan(signal);
}

function scheduleFileScan(signal: AbortSignal): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void scan("watcher", signal);
  }, DEBOUNCE_MS);
}

function watchAccess(target: string, directoryOnly = false): "available" | "missing" | "blocked" {
  try {
    const info = fs.statSync(target, { throwIfNoEntry: false });
    if (!info) return "missing";
    if (directoryOnly && !info.isDirectory()) return "blocked";
    fs.accessSync(target, fs.constants.R_OK | (info.isDirectory() ? fs.constants.X_OK : 0));
    return "available";
  } catch {
    return "blocked";
  }
}

function retryFileEvents(): void {
  if (fileRetryTimer) return;
  fileRetryTimer = setTimeout(() => {
    fileRetryTimer = null;
    if (!watcher) {
      syncWatcher();
      return;
    }
    for (const target of inaccessible) {
      const access = watchAccess(target);
      if (access === "blocked") continue;
      inaccessible.delete(target);
      if (access === "available") {
        watcher.source.add(target);
        scheduleFileScan(watcher.controller.signal);
      }
    }
    if (inaccessible.size > 0) retryFileEvents();
  }, FILE_RETRY_MS);
  fileRetryTimer.unref();
}

function fileEventsUnavailable(): "unavailable" {
  stopFileEvents();
  retryFileEvents();
  return "unavailable";
}

function startFileEvents(): WatcherStatus["fileEvents"] {
  try {
    if (watchAccess(MEDIA_DIR, true) !== "available") {
      if (status.fileEvents !== "unavailable") logger.warn("system", `File watcher: cannot watch ${MEDIA_DIR}`);
      return fileEventsUnavailable();
    }
    const source = chokidar.watch(MEDIA_DIR, {
      ignoreInitial: true,
      persistent: true,
      depth: 10,
      ignored: /(^|[/\\])\../,
      awaitWriteFinish: { stabilityThreshold: VIDEO_SETTLE_MS, pollInterval: 500 },
    });
    const controller = new AbortController();
    const { signal } = controller;
    watcher = { source, controller };

    source.on("add", (filePath) => handleFileChange(filePath, signal));
    source.on("change", (filePath) => handleFileChange(filePath, signal));
    source.once("ready", () => {
      if (signal.aborted) return;
      logger.info("system", `File watcher started on ${MEDIA_DIR}`);
      publishStatus(true, "watching");
      // The initial crawl suppresses file events. Reconcile files added while
      // the listener was paused or unavailable.
      scheduleFileScan(signal);
    });
    source.on("unlinkDir", (dir) => {
      if (signal.aborted || path.resolve(dir) !== path.resolve(MEDIA_DIR)) return;
      publishStatus(true, fileEventsUnavailable());
    });
    source.on("error", (error) => {
      if (signal.aborted) return;
      logger.error("system", `File watcher error: ${errorMessage(error)}`);
      const { code, path: failedPath } = error instanceof Error ? (error as NodeJS.ErrnoException) : {};
      if (
        (code === "EACCES" || code === "EPERM") &&
        failedPath &&
        normalizeMediaSubfolder(path.relative(MEDIA_DIR, failedPath)) !== null
      ) {
        // An inaccessible child should not disconnect the rest of the tree.
        inaccessible.add(path.resolve(failedPath));
        retryFileEvents();
        return;
      }
      publishStatus(true, fileEventsUnavailable());
    });
    return "starting";
  } catch (error) {
    logger.error("system", `File watcher error: ${errorMessage(error)}`);
    return fileEventsUnavailable();
  }
}

function stopFileEvents(): void {
  if (fileRetryTimer) {
    clearTimeout(fileRetryTimer);
    fileRetryTimer = null;
  }
  inaccessible.clear();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (!watcher) return;
  const { source, controller } = watcher;
  watcher = null;
  controller.abort();
  void source.close().catch((error) => logger.error("system", `File watcher close error: ${errorMessage(error)}`));
}

function syncPoll(minutes: number): void {
  if ((poll?.minutes ?? 0) === minutes) return;
  if (poll) {
    clearInterval(poll.timer);
    poll.controller.abort();
    poll = null;
  }
  if (minutes === 0) return;

  const controller = new AbortController();
  const timer = setInterval(() => {
    if (pollInProgress) return;
    pollInProgress = true;
    void scan("poll", controller.signal).finally(() => {
      pollInProgress = false;
    });
  }, minutes * 60_000);
  poll = { timer, minutes, controller };
  logger.info("system", `Watcher polling every ${minutes} minutes`);
}

function configuredPollInterval(): number {
  const minutes = Number(getSetting("auto_scan_interval"));
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 10080 ? minutes : 0;
}

/** Both sources share the persisted pause and the same scan pipeline. */
export function syncWatcher(): void {
  const allowed = getSetting("watcher_paused") !== "1";
  const useFileEvents = allowed && getSetting("watch_enabled") === "1";
  const minutes = allowed ? configuredPollInterval() : 0;
  syncPoll(minutes);
  if (!useFileEvents) stopFileEvents();
  const fileEvents = useFileEvents ? (watcher ? status.fileEvents : startFileEvents()) : "off";
  publishStatus(useFileEvents || minutes > 0, fileEvents);
}

export function setWatcherEnabled(enabled: boolean): WatcherStatus {
  setSettings({
    watcher_paused: enabled ? "0" : "1",
    // An unconfigured watcher starts with file events. A polling-only
    // installation keeps its original detection method when resumed.
    ...(enabled && getSetting("watch_enabled") !== "1" && configuredPollInterval() === 0 ? { watch_enabled: "1" } : {}),
  });
  syncWatcher();
  return getWatcherStatus();
}
