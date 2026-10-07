import fs from "node:fs";
import path from "node:path";
import { migrateConnectionsFromFlat, parseConnections } from "./connections.js";
import { standardizeTasks, standardTaskLangCode, type PreferredChinese } from "./language-codes.js";
import { computeLlmConfigured } from "./llm-configured.js";
import { logger } from "./logger.js";
import type { TranslationTask } from "../shared/tasks.js";
import { errorMessage } from "./errors.js";

const CONFIG_DIR = process.env.CONFIG_DIR || "./config";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

fs.mkdirSync(CONFIG_DIR, { recursive: true });

// --- Schema ---

export type { TranslationTask };

interface ConfigData {
  settings: Record<string, string>;
  tasks: TranslationTask[];
  _next_task_id: number;
}

export const AUTO_SOURCE_LANGUAGE = "Automatic";
export const DEFAULT_OUTPUT_PATTERN = "{{name}}.{{lang_code}}.srt";

// --- Defaults ---

const DEFAULT_SETTINGS: Record<string, string> = {
  llm_endpoint: "http://localhost:8000/v1",
  api_key: "",
  model: "Qwen/Qwen2.5-72B-Instruct",
  api_type: "openai",
  // Cloud provider selection: "local" | "openai" | "anthropic" | "gemini"
  cloud_provider: "local",
  cloud_api_key_openai: "",
  cloud_api_key_anthropic: "",
  cloud_api_key_gemini: "",
  cloud_model_openai: "gpt-4o",
  cloud_model_anthropic: "claude-3-5-sonnet-20241022",
  cloud_model_gemini: "gemini-2.5-flash",
  // Multi-connection: JSON array of LlmConnection. Empty → migrated from the
  // flat keys above at read time. llm_mode: single | fallback | parallel.
  llm_connections: "",
  llm_mode: "single",
  active_connection_id: "",
  scan_mode: "recursive",
  scan_folders: "",
  scan_exclude_folders: "",
  scan_profiles: "[]",
  // Per-directory translation control (see directory-rules.ts).
  // directory_rules: JSON array of DirectoryRule. translate_without_video: global
  // baseline for subtitles that have no companion video ("on" | "off").
  directory_rules: "[]",
  translate_without_video: "off",
  temperature: "0.3",
  chunk_size: "20",
  context_window: "5",
  parallel_chunks: "1",
  request_timeout_s: "300",
  disable_tool_calls: "1",
  // Refinement Pass (Pass 2): optional second LLM editing call per chunk for
  // natural flow/tone. Default off. Never degrades below pass-1 — a refined
  // chunk is only accepted when it returns the exact same line count.
  refine_pass: "0",
  // Series-Wide Memory (§2): when "1", a .subsmelt_glossary.json file in each
  // translated file's folder is loaded before analysis and updated after, so a
  // series stays consistent across files. Default off — behavior unchanged.
  series_memory: "0",
  // Translated Title Sidecar: when "1", after each successful translation the
  // media filename's title (release/quality tags stripped) is translated into
  // the target language and stored in a .subsmelt_titles.json sidecar next to
  // the output file. Titles already recorded for a language are skipped.
  // Default off — filenames on disk are never changed.
  title_sidecar: "0",
  auto_scan_interval: "0",
  // Soft monthly token budget for the cost/usage indicator. "0" = unlimited.
  // Display-only: NEVER blocks or throttles translation — it only powers a
  // visible "tokens used vs budget" hint in the UI.
  monthly_token_budget: "0",
  // Outbound webhook notifications. Empty webhook_url = disabled (default).
  // notify_events: comma list of which SSE events trigger a webhook. Defaults
  // to errors + queue-finished only, NOT every job:done (avoids per-file spam).
  // notify_format: payload shape — "json" | "discord" | "slack".
  notify_webhook_url: "",
  notify_events: "job:error,queue:finished",
  notify_format: "json",
  watch_enabled: "0",
  auto_translate: "1",
  video_extensions: ".mkv,.mp4,.avi,.m4v,.ts,.wmv,.mov",
  subtitle_extensions: ".srt,.ass,.ssa,.vtt",
  transcription_enabled: "0",
  transcription_backend_url: "",
  // Optional shared-secret token (Phase 1 remote hardening). When non-empty it
  // is sent as `Authorization: Bearer <token>` on every backend call. Empty =
  // no auth header (localhost dev default; backend auth also disabled then).
  transcription_backend_token: "",
  transcription_model: "small",
  transcription_device: "cpu",
  transcription_compute_type: "int8",
  transcription_language: "auto",
  // The script "Chinese" means here, written as .chi: zh-TW (Traditional, Taiwan) or zh-CN (Simplified).
  preferred_chinese: "zh-TW",
  transcription_use_vad: "1",
  transcription_output_format: "srt",
  transcription_sort_by: "date",
  transcription_sort_dir: "desc",
  dashboard_sort_by: "date",
  dashboard_sort_dir: "desc",
  transcription_max_line_length: "42",
  transcription_max_subtitle_duration: "6",
  transcription_merge_short_segments: "0",
  transcription_folder_defaults: "[]",
  transcription_advanced_stt: "{}",
  transcription_missing_subtitle_behavior: "ask",
  transcription_low_ram_behavior: "ask",
  transcription_max_concurrent: "1",
  // Backend request timeout in seconds for /transcribe (default 30min). Health
  // and preflight use a short fixed timeout in transcription-client.ts.
  transcription_request_timeout_s: "1800",
  transcription_path_map_from: "",
  transcription_path_map_to: "",
  // File transport mode (plan Phase 2). "auto" picks shared-FS path mode when a
  // path mapping is set or no token is configured (local same-host), and upload
  // mode when a token is set with no mapping (true remote). "shared" forces
  // path mode (Model A); "upload" forces multipart upload (Model B).
  transcription_transport: "auto",
  // "1" when Whisper and the translation model share one GPU: translation then
  // runs in batches after pending transcriptions (gpu-gate.ts).
  gpu_shared: "0",
  // YouTube. youtube_playlists is a JSON array owned by the playlist routes
  // (youtube/playlists.ts); the generic settings endpoints never read or write it.
  youtube_playlists: "[]",
  youtube_download_dir: "YouTube",
  youtube_notes_dir: "/notes",
  // Optional YouTube Data API key; only used to read when videos were added to a playlist.
  youtube_api_key: "",
  additional_context: "",
  prompt: `You are a professional subtitle translator.
You will receive subtitle text in an automatically detected source language.
Translate all subtitles into {{lang}}.
Note: {{additional}}
Do not merge sentences, translate them individually.
Return the translated subtitles in the same order and length as the input.
1. Detect the input subtitle language
2. Translate the input subtitles into {{lang}}
3. Convert names into {{lang}}
4. Return only the translated text, no explanations`,
};

const DEFAULT_TASK: TranslationTask = {
  id: 1,
  source_lang: AUTO_SOURCE_LANGUAGE,
  target_lang: "English",
  output_pattern: "{{name}}.{{lang_code}}.srt",
  lang_code: "eng",
  enabled: 1,
  prompt_override: "",
  created_at: new Date().toISOString(),
};

// --- Load / Save ---

function defaultConfig(): ConfigData {
  return {
    settings: { ...DEFAULT_SETTINGS },
    tasks: [{ ...DEFAULT_TASK }],
    _next_task_id: 2,
  };
}

function loadConfig(): ConfigData {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8");
      const data = JSON.parse(raw) as ConfigData;
      // Merge defaults for any missing settings
      data.settings = { ...DEFAULT_SETTINGS, ...data.settings };
      if (!data.tasks) data.tasks = [DEFAULT_TASK];
      data.tasks = data.tasks.map((task) => ({
        ...task,
        source_lang: !task.source_lang || task.source_lang === "English" ? AUTO_SOURCE_LANGUAGE : task.source_lang,
      }));
      // Tasks from before the language-code standard move to it ("en" -> "eng").
      // One at a time, so two old spellings of one language never both take its code.
      data.tasks = standardizeTasks(data.tasks, data.settings.preferred_chinese === "zh-CN" ? "zh-CN" : "zh-TW");
      if (!data._next_task_id) data._next_task_id = Math.max(0, ...data.tasks.map((t) => t.id)) + 1;
      return data;
    }
  } catch (e) {
    // Keep the operator's tasks, connections and keys recoverable: back the file
    // up, leave it in place, and refuse to overwrite it until the user says so.
    const backup = `${CONFIG_FILE}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(CONFIG_FILE, backup);
    const message = e instanceof Error ? errorMessage(e) : String(e);
    configLoadFailure = { file: CONFIG_FILE, backup, message };
    logger.error(
      "system",
      `Could not read ${CONFIG_FILE} (${message}). Copied it to ${backup}; running on defaults and not saving until the file is fixed or replaced from Settings.`,
    );
    return defaultConfig();
  }

  // First run — create with defaults
  const config = defaultConfig();
  saveConfig(config);
  return config;
}

export interface ConfigLoadFailure {
  file: string;
  backup: string;
  message: string;
}

// Set when config.json exists but could not be parsed. Until the user replaces
// it from Settings, nothing writes the file: the first background save (a scan
// recording media_scanned) would otherwise swap their setup for the defaults.
let configLoadFailure: ConfigLoadFailure | null = null;
let skippedSaveLogged = false;

function saveConfig(config: ConfigData): void {
  if (configLoadFailure) {
    if (!skippedSaveLogged) {
      skippedSaveLogged = true;
      logger.warn("system", `Not saving settings: ${configLoadFailure.file} could not be read and is kept as it is.`);
    }
    return;
  }
  const tmpPath = `${CONFIG_FILE}.tmp`;
  const json = JSON.stringify(config, null, 2);
  // Holds API keys: never world-readable, not even before the chmod below.
  fs.writeFileSync(tmpPath, json, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmpPath, CONFIG_FILE);
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    fs.writeFileSync(CONFIG_FILE, json, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(CONFIG_FILE, 0o600);
    try {
      fs.unlinkSync(tmpPath);
    } catch (e) {
      console.error(`[Config] Failed to remove temp file ${tmpPath}:`, e);
    }
  }
}

// In-memory cache — loaded once, written on every mutation
const _config: ConfigData = loadConfig();

export function getConfigLoadFailure(): ConfigLoadFailure | null {
  return configLoadFailure;
}

/** The user chose to replace the unreadable file with the settings running now. */
export function replaceBrokenConfig(): void {
  configLoadFailure = null;
  skippedSaveLogged = false;
  saveConfig(_config);
}

// --- Settings ---

export function getSetting(key: string): string {
  return envPinnedSettings[key] ?? _config.settings[key] ?? DEFAULT_SETTINGS[key] ?? "";
}

/** The value a setting ships with, before config.json or the environment changes it. */
export function defaultSetting(key: string): string {
  return DEFAULT_SETTINGS[key] ?? "";
}

export function setSetting(key: string, value: string): void {
  setSettings({ [key]: value });
}

// Batch variant: mutate the in-memory config once for all keys in `patch`, then
// persist with a SINGLE saveConfig. Avoids N disk writes per multi-key save and
// the concurrent-request clobber window of calling setSetting in a loop.
export function setSettings(patch: Record<string, string>): void {
  const before = preferredChinese();
  const persistable =
    "llm_connections" in patch ? { ...patch, llm_connections: persistableConnections(patch.llm_connections) } : patch;
  _config.settings = { ..._config.settings, ...persistable };
  // .chi is the preferred script: a switch moves the Chinese tasks now, not at the next start.
  if (preferredChinese() !== before) _config.tasks = standardizeTasks(_config.tasks, preferredChinese());
  saveConfig(_config);
}

// Allow-list of writable setting keys for POST /api/settings. Derived from the
// known schema (DEFAULT_SETTINGS) so it stays in sync automatically — any key
// the UI legitimately persists has a default here. Requests carrying unknown
// keys are rejected (skipped) by the route to avoid arbitrary config injection.
const WRITABLE_SETTING_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_SETTINGS));

export function isWritableSettingKey(key: string): boolean {
  return WRITABLE_SETTING_KEYS.has(key);
}

export function getAllSettings(): Record<string, string> {
  const merged = { ...DEFAULT_SETTINGS, ..._config.settings, ...envPinnedSettings };
  // Backfill the connections array from legacy flat keys so the client and the
  // queue always see a populated list, even before the first multi-connection save.
  if (!merged.llm_connections?.trim()) {
    merged.llm_connections = JSON.stringify(migrateConnectionsFromFlat(merged));
  } else {
    merged.llm_connections = withEnvLocalConnection(merged.llm_connections);
  }
  return merged;
}

// LLM_ENDPOINT, API_KEY and MODEL configure the "local" connection, the one the
// connections list starts from. Once the list has been saved the flat keys no
// longer feed it, so the env values are laid over that connection at read time
// and swapped back for the saved values on save: env values never reach config.json.
const LOCAL_CONNECTION_ID = "local";
const ENV_LOCAL_CONNECTION_FIELDS: Record<string, "endpoint" | "apiKey" | "model"> = {
  llm_endpoint: "endpoint",
  api_key: "apiKey",
  model: "model",
};

function mapLocalConnection(
  json: string,
  fn: (connection: Record<string, unknown>) => Record<string, unknown>,
): string {
  let connections: unknown;
  try {
    connections = JSON.parse(json);
  } catch {
    return json;
  }
  if (!Array.isArray(connections)) return json;
  return JSON.stringify(
    connections.map((c) =>
      c && typeof c === "object" && c.id === LOCAL_CONNECTION_ID && (c.provider ?? "local") === "local" ? fn(c) : c,
    ),
  );
}

function withEnvLocalConnection(json: string): string {
  const pinned = Object.entries(ENV_LOCAL_CONNECTION_FIELDS).filter(([key]) => key in envPinnedSettings);
  if (pinned.length === 0) return json;
  return mapLocalConnection(json, (c) => ({
    ...c,
    ...Object.fromEntries(pinned.map(([key, field]) => [field, envPinnedSettings[key]])),
  }));
}

/**
 * An `llm_connections` value fit to save. Each env-pinned field of the local
 * connection goes back to what config.json holds for it (the saved connection,
 * or the flat key a list that was never saved is built from), never the env
 * value or a blank, so removing the env variable brings the saved setup back.
 */
export function persistableConnections(json: string): string {
  const pinned = Object.entries(ENV_LOCAL_CONNECTION_FIELDS).filter(([key]) => key in envPinnedSettings);
  if (pinned.length === 0) return json;
  const stored = _config.settings.llm_connections?.trim()
    ? parseConnections({ llm_connections: _config.settings.llm_connections })
    : migrateConnectionsFromFlat({ ...DEFAULT_SETTINGS, ..._config.settings });
  const storedLocal = stored.find((c) => c.id === LOCAL_CONNECTION_ID && c.provider === "local");
  return mapLocalConnection(json, (c) => ({
    ...c,
    ...Object.fromEntries(
      pinned.map(([key, field]) => [
        field,
        storedLocal ? storedLocal[field] : (_config.settings[key] ?? DEFAULT_SETTINGS[key] ?? ""),
      ]),
    ),
  }));
}

/**
 * Has the operator actually configured an LLM, or is this still the shipped
 * default? Surfaced to the UI as `_llm_configured`; see llm-configured.ts for
 * why the merged settings can't answer this.
 */
export function isLlmConfigured(): boolean {
  // Pass the connections the defaults would synthesize, so a seeded connection
  // written back by an unrelated settings save isn't mistaken for real setup.
  return computeLlmConfigured(
    { ..._config.settings, ...envPinnedSettings },
    DEFAULT_SETTINGS,
    migrateConnectionsFromFlat(DEFAULT_SETTINGS),
  );
}

// --- Translation Tasks ---

/** The Chinese script written as .chi; the other one is .chs or .cht. */
export function preferredChinese(): PreferredChinese {
  return getSetting("preferred_chinese") === "zh-CN" ? "zh-CN" : "zh-TW";
}

export function getTasks(): TranslationTask[] {
  return _config.tasks;
}

export function getTask(id: number): TranslationTask | undefined {
  return _config.tasks.find((t) => t.id === id);
}

// The lang_code lands in output file names ("Movie.<lang_code>.srt") and in
// prompt context, so it must be a plain token — a traversal or separator would
// compose paths outside the media folder.
const LANG_CODE_RE = /^[A-Za-z0-9_-]+$/;

export function validateTaskLangCode(langCode: string, excludeTaskId?: number): string | null {
  if (!LANG_CODE_RE.test(langCode)) return "lang_code must contain only letters, digits, dashes and underscores";
  const duplicate = _config.tasks.some((t) => t.lang_code === langCode && t.id !== excludeTaskId);
  if (duplicate)
    return `A task with language code "${langCode}" already exists — two tasks sharing it would write the same output files`;
  return null;
}

export function createTask(task: {
  source_lang: string;
  target_lang: string;
  output_pattern: string;
  lang_code: string;
  enabled?: 0 | 1;
}): { lastInsertRowid: number } {
  const id = _config._next_task_id++;
  const newTask: TranslationTask = {
    id,
    source_lang: task.source_lang,
    target_lang: task.target_lang,
    output_pattern: task.output_pattern,
    lang_code: standardTaskLangCode(task, preferredChinese()),
    enabled: task.enabled ?? 1,
    prompt_override: "",
    created_at: new Date().toISOString(),
  };
  _config.tasks.push(newTask);
  saveConfig(_config);
  return { lastInsertRowid: id };
}

export function updateTask(
  id: number,
  updates: Partial<{
    source_lang: string;
    target_lang: string;
    output_pattern: string;
    lang_code: string;
    enabled: number;
    prompt_override: string;
  }>,
): void {
  const task = _config.tasks.find((t) => t.id === id);
  if (!task) return;
  const previousCode = task.lang_code;
  const previousLanguage = standardTaskLangCode(task, preferredChinese());
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) {
      (task as unknown as Record<string, unknown>)[k] = v;
    }
  }
  const next = standardTaskLangCode(task, preferredChinese());
  // A code another task already has stays as it is, as loading leaves it.
  if (!_config.tasks.some((t) => t.id !== id && t.lang_code === next)) task.lang_code = next;
  if (next !== previousLanguage) {
    // Another language now: files named with the old one's codes are not this task's.
    task.former_lang_codes = [];
  } else if (task.lang_code !== previousCode) {
    // The same language, spelled the standard way: files written with the old code keep counting.
    task.former_lang_codes = [...new Set([...(task.former_lang_codes ?? []), previousCode])];
  }
  saveConfig(_config);
}

export function deleteTask(id: number): void {
  _config.tasks = _config.tasks.filter((t) => t.id !== id);
  saveConfig(_config);
}

export function getConfigFilePath(): string {
  return CONFIG_FILE;
}

/**
 * Settings that can be seeded from the environment at startup.
 *
 * Deployments that configure the app entirely through compose need a way to set
 * these without clicking through the UI. The token matters most: arming
 * SUBSMELT_WHISPER_TOKEN on the backend without giving SubSmelt the same secret
 * turns every transcription request into a 401, and before this there was no
 * env-level way to supply it.
 */
export const ENV_SETTING_OVERRIDES: Record<string, string> = {
  LLM_ENDPOINT: "llm_endpoint",
  API_KEY: "api_key",
  MODEL: "model",
  WHISPER_BACKEND_URL: "transcription_backend_url",
  WHISPER_BACKEND_TOKEN: "transcription_backend_token",
  // Lets the compose shared-FS setup pin transport=shared (the backend reads
  // /media in place); otherwise auto picks upload for a non-loopback host.
  WHISPER_TRANSPORT: "transcription_transport",
};

/** Settings to seed from `env`, skipping unset and empty values. */
export function envSettingOverrides(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [envKey, settingKey] of Object.entries(ENV_SETTING_OVERRIDES)) {
    const value = env[envKey];
    // An empty string is a deliberate "leave it alone", not a value to store —
    // compose files routinely declare a variable with no value.
    if (value !== undefined && value !== "") overrides[settingKey] = value;
  }
  return overrides;
}

// Layered over config.json for this process and never saved, so a UI save
// cannot bake an env value into the file and removing the variable brings the
// saved value back on the next start.
const envPinnedSettings = envSettingOverrides();

/** Setting keys whose value comes from the environment; the UI cannot edit them. */
export function envPinnedSettingKeys(): string[] {
  return Object.keys(envPinnedSettings);
}
