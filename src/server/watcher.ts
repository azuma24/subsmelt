import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs";
import { getSetting, setSettings } from "./config.js";
import { MEDIA_DIR } from "./scanner.js";
import { scanAndEnqueue } from "./library-scan.js";
import { logger } from "./logger.js";
import { errorMessage } from "./errors.js";
import { broadcast } from "./sse.js";
import type { WatcherStatus } from "../shared/watcher.js";

const DEBOUNCE_MS = 5000;
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
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void scan("watcher", signal);
  }, DEBOUNCE_MS);
}

function startFileEvents(): WatcherStatus["fileEvents"] {
  try {
    if (!fs.statSync(MEDIA_DIR, { throwIfNoEntry: false })?.isDirectory()) {
      logger.warn("system", `File watcher: ${MEDIA_DIR} is not a directory`);
      return "unavailable";
    }
    const source = chokidar.watch(MEDIA_DIR, {
      ignoreInitial: true,
      persistent: true,
      depth: 10,
      ignored: /(^|[/\\])\../,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
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
    });
    source.on("error", (error: unknown) => {
      if (signal.aborted) return;
      logger.error("system", `File watcher error: ${errorMessage(error)}`);
      stopFileEvents();
      publishStatus(true, "unavailable");
    });
    return "starting";
  } catch (error) {
    logger.error("system", `File watcher error: ${errorMessage(error)}`);
    return "unavailable";
  }
}

function stopFileEvents(): void {
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
