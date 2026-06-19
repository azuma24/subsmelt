import type { Express } from "express";
import {
  AUTO_SOURCE_LANGUAGE,
  getAllSettings,
  setSettings,
  getSetting,
  isWritableSettingKey,
  getTasks,
  createTask,
  updateTask,
  deleteTask,
} from "../config.js";
import { scanFolder, MEDIA_DIR } from "../scanner.js";
import { startAutoScan, stopAutoScan } from "../queue.js";
import { convertSubtitle } from "../translator.js";
import { logger } from "../logger.js";
import { isWatcherRunning, restartWatcher } from "../watcher.js";

// Pure client-driven format conversion (no translation, no DB). The browser
// uploads file contents; we re-stringify each into the target format and return
// them inline. Per-file failures are collected in `errors` so one bad file
// never fails the whole batch.
const CONVERT_TARGET_FORMATS = ["srt", "vtt", "ass", "ssa"] as const;
const MAX_CONVERT_FILES = 50;
const MAX_CONVERT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

export function registerSettingsTasksRoutes(app: Express): void {
  // ======== Settings ========
  app.get("/api/settings", (_req, res) => {
    res.json({
      ...getAllSettings(),
      _media_dir: MEDIA_DIR,
      _watcher_running: isWatcherRunning(),
    });
  });

  app.post("/api/settings", (req, res) => {
    const settings = req.body && typeof req.body === "object" ? req.body : {};
    const changedKeys: string[] = [];
    // Reject any key not on the writable allow-list (derived from the settings
    // schema). Underscore-prefixed keys are read-only computed fields; unknown
    // keys are silently skipped and reported back in `rejected` so a misbehaving
    // or malicious client can't inject arbitrary config entries.
    const rejected: string[] = [];
    // Build a validated patch first, then write once via setSettings (a single
    // disk write, no per-key concurrent-clobber window).
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith("_")) continue;
      if (!isWritableSettingKey(key)) {
        rejected.push(key);
        continue;
      }
      // Only accept string values. Non-strings (arrays/objects/numbers/booleans)
      // are rejected rather than silently coerced via String(value) — e.g.
      // ["a"] must not become "a".
      if (typeof value !== "string") {
        rejected.push(key);
        continue;
      }
      patch[key] = value;
      changedKeys.push(key);
    }
    if (changedKeys.length > 0) setSettings(patch);
    logger.info("system", `Settings updated: ${changedKeys.join(", ")}`);
    if (rejected.length > 0) {
      logger.info("system", `Settings rejected (unknown keys): ${rejected.join(", ")}`);
    }

    const interval = parseInt(getSetting("auto_scan_interval") || "0", 10);
    if (interval > 0) startAutoScan(interval, scanFolder);
    else stopAutoScan();

    if (changedKeys.includes("watch_enabled")) {
      restartWatcher();
    }
    res.json({ ok: true, rejected });
  });

  // ======== Translation Tasks ========
  app.get("/api/tasks", (_req, res) => res.json(getTasks()));

  app.post("/api/tasks", (req, res) => {
    const { source_lang, target_lang, output_pattern, lang_code } = req.body;
    if (!target_lang || !lang_code) return res.status(400).json({ error: "target_lang and lang_code are required" });
    const result = createTask({
      source_lang: source_lang || AUTO_SOURCE_LANGUAGE,
      target_lang,
      output_pattern: output_pattern || "{{name}}.{{lang_code}}.srt",
      lang_code,
    });
    logger.info("system", `Created translation task: ${target_lang} (${lang_code})`);
    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  });

  app.put("/api/tasks/:id", (req, res) => {
    updateTask(parseInt(req.params.id, 10), req.body);
    res.json({ ok: true });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    deleteTask(id);
    logger.info("system", `Deleted translation task #${id}`);
    res.json({ ok: true });
  });

  // ======== Subtitle Format Converter ========
  app.post("/api/convert", (req, res) => {
    const body = req.body ?? {};
    const targetFormat = String(body.targetFormat || "").toLowerCase();
    const files = Array.isArray(body.files) ? body.files : null;

    if (!CONVERT_TARGET_FORMATS.includes(targetFormat as (typeof CONVERT_TARGET_FORMATS)[number])) {
      return res.status(400).json({ error: `Unsupported target format. Use one of: ${CONVERT_TARGET_FORMATS.join(", ")}` });
    }
    if (!files) {
      return res.status(400).json({ error: "files must be an array of { name, content }" });
    }
    if (files.length === 0) {
      return res.status(400).json({ error: "No files provided" });
    }
    if (files.length > MAX_CONVERT_FILES) {
      return res.status(400).json({ error: `Too many files (max ${MAX_CONVERT_FILES})` });
    }
    for (const file of files) {
      const content = typeof file?.content === "string" ? file.content : "";
      if (Buffer.byteLength(content, "utf8") > MAX_CONVERT_FILE_BYTES) {
        return res.status(400).json({ error: `File too large: ${String(file?.name || "unknown")} (max 10MB per file)` });
      }
    }

    const outputs: { name: string; content: string }[] = [];
    const errors: { name: string; error: string }[] = [];

    for (const file of files) {
      const name = String(file?.name || "subtitle");
      const content = typeof file?.content === "string" ? file.content : "";
      const dotIndex = name.lastIndexOf(".");
      const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
      const sourceExt = dotIndex >= 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
      try {
        const converted = convertSubtitle(content, sourceExt, targetFormat);
        outputs.push({ name: `${baseName}.${targetFormat}`, content: converted });
      } catch (error) {
        errors.push({ name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    logger.info("system", `Converted ${outputs.length}/${files.length} subtitle file(s) → ${targetFormat}`);
    res.json({ files: outputs, errors });
  });
}
