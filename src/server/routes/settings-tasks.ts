import type { Express } from "express";
import {
  AUTO_SOURCE_LANGUAGE,
  getAllSettings,
  getConfigLoadFailure,
  replaceBrokenConfig,
  setSettings,
  getSetting,
  envPinnedSettingKeys,
  isLlmConfigured,
  isWritableSettingKey,
  getTask,
  getTasks,
  preferredChinese,
  createTask,
  updateTask,
  deleteTask,
  validateTaskLangCode,
  persistableConnections,
} from "../config.js";
import { deletePendingJobsForTask } from "../db.js";
import { standardTaskLangCode } from "../language-codes.js";
import { scanFolder, MEDIA_DIR } from "../scanner.js";
import { startAutoScan, stopAutoScan } from "../queue.js";
import { REDACTED_SECRET, parseConnections, restoreRedactedApiKeys } from "../connections.js";
import { logger } from "../logger.js";
import { normalizeMediaSubfolder } from "../media-paths.js";
import { isWatcherRunning, restartWatcher } from "../watcher.js";
import { parseTaskUpdate, settingError, validateOutputPattern } from "./validation.js";
import { SECRET_SETTING_KEYS } from "../settings-schema.js";

// Which keys are secrets is part of the settings schema (src/shared/settings.ts).
// Owned by the YouTube playlist routes. A Settings save sends back the whole
// settings object it loaded, which would overwrite playlists followed since.
const ROUTE_OWNED_SETTING_KEYS = new Set(["youtube_playlists"]);

function redactSettings(settings: Record<string, string>): Record<string, string> {
  const redacted = { ...settings };
  for (const key of ROUTE_OWNED_SETTING_KEYS) delete redacted[key];
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
              : connection,
          ),
        );
      }
    } catch {
      // Preserve malformed settings for the existing client-side recovery path.
    }
  }
  return redacted;
}

export function registerSettingsTasksRoutes(
  app: Express,
  scanAndEnqueue: () => Promise<{ newJobs: number; totalSubtitles: number }> = scanFolder,
): void {
  // ======== Settings ========
  app.get("/api/settings", (_req, res) => {
    res.json({
      ...redactSettings(getAllSettings()),
      _media_dir: MEDIA_DIR,
      _watcher_running: isWatcherRunning(),
      // Whether an LLM has actually been set up, as opposed to running on the
      // shipped defaults — the merged settings can't distinguish the two.
      _llm_configured: isLlmConfigured(),
      _env_pinned: envPinnedSettingKeys(),
      // config.json exists but could not be parsed; the UI offers to replace it.
      _config_load_error: getConfigLoadFailure(),
    });
  });

  // The explicit confirmation a broken config.json waits for before it is overwritten.
  app.post("/api/settings/replace-broken-config", (_req, res) => {
    const failure = getConfigLoadFailure();
    replaceBrokenConfig();
    if (failure)
      logger.warn(
        "system",
        `Replaced unreadable ${failure.file} with the current settings; the original is kept at ${failure.backup}`,
      );
    res.json({ ok: true });
  });

  app.post("/api/settings", (req, res) => {
    const loadFailure = getConfigLoadFailure();
    if (loadFailure) {
      return res.status(409).json({
        error: `${loadFailure.file} could not be read, so settings are not saved. Fix the file and restart, or replace it from Settings (a copy is at ${loadFailure.backup}).`,
      });
    }
    const settings = req.body && typeof req.body === "object" ? { ...req.body } : {};
    if (typeof settings.youtube_download_dir === "string") {
      const folder = normalizeMediaSubfolder(settings.youtube_download_dir);
      if (!folder)
        return res.status(400).json({ error: "The YouTube download folder must be a folder inside the media folder" });
      settings.youtube_download_dir = folder.replace(/\/+$/, "");
    }
    const changedKeys: string[] = [];
    // Reject any key not on the writable allow-list (derived from the settings
    // schema). Underscore-prefixed keys are read-only computed fields; unknown
    // keys are silently skipped and reported back in `rejected` so a misbehaving
    // or malicious client can't inject arbitrary config entries.
    const rejected: string[] = [];
    // Build a validated patch first, then write once via setSettings (a single
    // disk write, no per-key concurrent-clobber window).
    const patch: Record<string, string> = {};
    const invalid: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith("_")) continue;
      if (!isWritableSettingKey(key) || ROUTE_OWNED_SETTING_KEYS.has(key)) {
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
      // GET may show connections synthesized from env-set values. Posting that
      // list back unchanged is not an edit, and saving it would copy the env
      // values (the API key included) into config.json.
      if (key === "llm_connections" && value === redactSettings(getAllSettings()).llm_connections) continue;
      // Secret values are never returned by GET. A client that saves unrelated
      // settings therefore sends the redaction marker back; preserve the
      // existing secret in that case, while an empty/new value still edits it.
      const resolved =
        SECRET_SETTING_KEYS.has(key) && value === REDACTED_SECRET
          ? getSetting(key)
          : key === "llm_connections"
            ? persistableConnections(restoreRedactedApiKeys(value, parseConnections(getAllSettings())))
            : value;
      // Clients (the Settings page included) PUT the whole settings object, so
      // most keys in any given request are unchanged. Writing and logging all of
      // them buried real edits under ~60 keys of noise on every save.
      if (resolved === getSetting(key)) continue;
      // An env-pinned key would save fine and then stay hidden behind the env value.
      if (envPinnedSettingKeys().includes(key)) {
        rejected.push(key);
        continue;
      }
      // Only changed values are checked, so a bad value already on disk never
      // blocks saving something else.
      const valueError = settingError(key, resolved);
      if (valueError) {
        invalid.push(valueError);
        continue;
      }
      patch[key] = resolved;
      changedKeys.push(key);
    }
    // One bad number refuses the whole request, so the form keeps every edit pending.
    if (invalid.length > 0) return res.status(400).json({ error: invalid.join("; ") });
    if (changedKeys.length > 0) {
      setSettings(patch);
      logger.info("system", `Settings updated: ${changedKeys.join(", ")}`);
    }
    if (rejected.length > 0) {
      logger.info("system", `Settings rejected (unknown keys): ${rejected.join(", ")}`);
    }

    const interval = parseInt(getSetting("auto_scan_interval") || "0", 10);
    if (interval > 0) startAutoScan(interval, scanAndEnqueue);
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
    if (output_pattern !== undefined && typeof output_pattern !== "string")
      return res.status(400).json({ error: "output_pattern must be a string" });
    // Saved as the standard code ("kor" is stored as "ko"), so check that one for duplicates.
    const langCodeError =
      validateTaskLangCode(String(lang_code)) ??
      validateTaskLangCode(
        standardTaskLangCode({ target_lang: String(target_lang), lang_code: String(lang_code) }, preferredChinese()),
      );
    if (langCodeError) return res.status(400).json({ error: langCodeError });
    const pattern = validateOutputPattern(typeof output_pattern === "string" ? output_pattern : "");
    if (!pattern.ok) return res.status(400).json({ error: pattern.error });
    const result = createTask({
      source_lang: source_lang || AUTO_SOURCE_LANGUAGE,
      target_lang,
      output_pattern: pattern.value,
      lang_code,
    });
    logger.info("system", `Created translation task: ${target_lang} (${lang_code})`);
    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  });

  app.put("/api/tasks/:id", (req, res) => {
    const update = parseTaskUpdate(req.body);
    if (!update.ok) return res.status(400).json({ error: update.error });
    if (update.value.lang_code !== undefined) {
      const id = parseInt(req.params.id, 10);
      const targetLang = update.value.target_lang ?? getTask(id)?.target_lang ?? "";
      const langCodeError =
        validateTaskLangCode(update.value.lang_code, id) ??
        validateTaskLangCode(
          standardTaskLangCode({ target_lang: targetLang, lang_code: update.value.lang_code }, preferredChinese()),
          id,
        );
      if (langCodeError) return res.status(400).json({ error: langCodeError });
    }
    updateTask(parseInt(req.params.id, 10), update.value);
    res.json({ ok: true });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    deleteTask(id);
    const removedJobs = deletePendingJobsForTask(id);
    logger.info("system", `Deleted translation task #${id} and its ${removedJobs} pending job(s)`);
    res.json({ ok: true });
  });
}
