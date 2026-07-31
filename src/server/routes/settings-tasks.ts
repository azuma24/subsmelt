import type { Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { convertSubtitle, probeModelContext, summarizeTranslationError, translateFile } from "../translator.js";
import { resolveConnectionPool } from "../connections.js";
import { logger } from "../logger.js";
import { isWatcherRunning, restartWatcher } from "../watcher.js";

// Pure client-driven format conversion (no translation, no DB). The browser
// uploads file contents; we re-stringify each into the target format and return
// them inline. Per-file failures are collected in `errors` so one bad file
// never fails the whole batch.
const CONVERT_TARGET_FORMATS = ["srt", "vtt", "ass", "ssa"] as const;
const MAX_CONVERT_FILES = 50;
const MAX_CONVERT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const REDACTED_SECRET = "__SUBSMELT_SECRET_REDACTED__";
const SECRET_SETTING_KEYS = new Set([
  "api_key",
  "cloud_api_key_openai",
  "cloud_api_key_anthropic",
  "cloud_api_key_gemini",
  "transcription_backend_token",
]);

function redactSettings(settings: Record<string, string>): Record<string, string> {
  const redacted = { ...settings };
  for (const key of SECRET_SETTING_KEYS) {
    if (redacted[key]) redacted[key] = REDACTED_SECRET;
  }

  if (redacted.llm_connections) {
    try {
      const connections = JSON.parse(redacted.llm_connections);
      if (Array.isArray(connections)) {
        redacted.llm_connections = JSON.stringify(
          connections.map((connection) =>
            connection && typeof connection === "object" && connection.apiKey
              ? { ...connection, apiKey: REDACTED_SECRET }
              : connection
          )
        );
      }
    } catch {
      // Preserve malformed settings for the existing client-side recovery path.
    }
  }
  return redacted;
}

function restoreRedactedConnections(value: string): string {
  try {
    const incoming = JSON.parse(value);
    const existing = JSON.parse(getSetting("llm_connections") || "[]");
    if (!Array.isArray(incoming) || !Array.isArray(existing)) return value;
    const existingById = new Map(existing.map((connection) => [connection?.id, connection]));
    return JSON.stringify(
      incoming.map((connection) => {
        const previous = existingById.get(connection?.id);
        if (
          connection &&
          typeof connection === "object" &&
          connection.apiKey === REDACTED_SECRET &&
          previous?.apiKey
        ) {
          return { ...connection, apiKey: previous.apiKey };
        }
        return connection;
      })
    );
  } catch {
    return value;
  }
}

export function registerSettingsTasksRoutes(app: Express): void {
  // ======== Settings ========
  app.get("/api/settings", (_req, res) => {
    res.json({
      ...redactSettings(getAllSettings()),
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
      // Secret values are never returned by GET. A client that saves unrelated
      // settings therefore sends the redaction marker back; preserve the
      // existing secret in that case, while an empty/new value still edits it.
      patch[key] = SECRET_SETTING_KEYS.has(key) && value === REDACTED_SECRET
        ? getSetting(key)
        : key === "llm_connections"
          ? restoreRedactedConnections(value)
          : value;
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

  // ======== Subtitle Format Converter / Translator ========
  app.post("/api/convert", async (req, res) => {
    const body = req.body ?? {};
    const targetFormat = String(body.targetFormat || "").toLowerCase();
    const translate = body.translate === true;
    const sourceLang = String(body.sourceLang || AUTO_SOURCE_LANGUAGE).trim() || AUTO_SOURCE_LANGUAGE;
    const targetLang = String(body.targetLang || "").trim();
    const files = Array.isArray(body.files) ? body.files : null;

    if (!CONVERT_TARGET_FORMATS.includes(targetFormat as (typeof CONVERT_TARGET_FORMATS)[number])) {
      return res.status(400).json({ error: `Unsupported target format. Use one of: ${CONVERT_TARGET_FORMATS.join(", ")}` });
    }
    if (translate && !targetLang) {
      return res.status(400).json({ error: "targetLang is required when translate is enabled" });
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
    const settings = getAllSettings();
    const { mode, pool } = resolveConnectionPool(settings);
    const primary = pool[0];
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-convert-"));

    try {
      for (const file of files) {
        const name = String(file?.name || "subtitle");
        const content = typeof file?.content === "string" ? file.content : "";
        const dotIndex = name.lastIndexOf(".");
        const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
        const sourceExt = dotIndex >= 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
        const outName = `${baseName}${translate ? ".translated" : ""}.${targetFormat}`;
        try {
          if (!translate) {
            const converted = convertSubtitle(content, sourceExt, targetFormat);
            outputs.push({ name: outName, content: converted });
            continue;
          }

          if (!primary) throw new Error("No usable LLM connection configured");
          const inputPath = path.join(tmpRoot, `${outputs.length}-${baseName}.${sourceExt || "srt"}`);
          const outputPath = path.join(tmpRoot, `${outputs.length}-${baseName}.translated.${targetFormat}`);
          fs.writeFileSync(inputPath, content, "utf8");

          const chunkSize = parseInt(settings.chunk_size || "20", 10);
          const apiHost = primary.apiHost || settings.llm_endpoint || "http://localhost:8000/v1";
          const model = primary.model || "";
          const ctxInfo = await probeModelContext(apiHost, model, chunkSize);
          const configuredParallel = Math.max(1, Math.min(8, parseInt(settings.parallel_chunks || "1", 10)));
          const parallelChunks = configuredParallel > 1 ? configuredParallel : ctxInfo.recommendedParallelChunks;
          const requestTimeoutMs = Math.max(5_000, parseInt(settings.request_timeout_s || "300", 10) * 1000);

          await translateFile({
            srtPath: inputPath,
            outputPath,
            apiKey: primary.apiKey || "",
            apiHost,
            model,
            provider: primary.provider,
            connections: pool,
            llmMode: mode,
            prompt: settings.prompt || "",
            lang: targetLang,
            sourceLang,
            additional: settings.additional_context || "",
            temperature: parseFloat(settings.temperature || "0.7"),
            chunkSize,
            contextSize: parseInt(settings.context_window || "5", 10),
            parallelChunks,
            maxAnalysisLines: ctxInfo.recommendedAnalysisLines,
            requestTimeoutMs,
            disableToolCalls: settings.disable_tool_calls === "1",
            refinePass: settings.refine_pass === "1",
            seriesMemory: false,
            onRetry: (attempt, error, backoff) => {
              const diagnostics = summarizeTranslationError(error);
              logger.warn("translate", `Convert retry ${attempt}: ${diagnostics.message} (backoff ${backoff}ms)`);
            },
          });
          outputs.push({ name: outName, content: fs.readFileSync(outputPath, "utf8") });
        } catch (error) {
          errors.push({ name, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    logger.info("system", `${translate ? "Translated+converted" : "Converted"} ${outputs.length}/${files.length} subtitle file(s) → ${targetFormat}`);
    res.json({ files: outputs, errors });
  });
}
