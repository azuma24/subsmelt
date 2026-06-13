import fs from "node:fs";
import path from "node:path";
import { migrateConnectionsFromFlat } from "./connections.js";

const CONFIG_DIR = process.env.CONFIG_DIR || "./config";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

fs.mkdirSync(CONFIG_DIR, { recursive: true });

// --- Schema ---

interface TranslationTask {
  id: number;
  source_lang: string;
  target_lang: string;
  output_pattern: string;
  lang_code: string;
  enabled: number;
  prompt_override: string;
  created_at: string;
}

interface ConfigData {
  settings: Record<string, string>;
  tasks: TranslationTask[];
  _next_task_id: number;
}

export const AUTO_SOURCE_LANGUAGE = "Automatic";

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
  temperature: "0.7",
  chunk_size: "20",
  context_window: "5",
  parallel_chunks: "1",
  request_timeout_s: "300",
  disable_tool_calls: "1",
  auto_scan_interval: "0",
  watch_enabled: "0",
  auto_translate: "1",
  video_extensions: ".mkv,.mp4,.avi,.m4v,.ts,.wmv,.mov",
  subtitle_extensions: ".srt,.ass,.ssa,.vtt",
  transcription_enabled: "0",
  transcription_backend_url: "",
  transcription_model: "small",
  transcription_device: "cpu",
  transcription_compute_type: "int8",
  transcription_language: "auto",
  transcription_use_vad: "1",
  transcription_output_format: "srt",
  transcription_max_line_length: "42",
  transcription_max_subtitle_duration: "6",
  transcription_merge_short_segments: "0",
  transcription_folder_defaults: "[]",
  transcription_advanced_stt: "{}",
  transcription_missing_subtitle_behavior: "ask",
  transcription_low_ram_behavior: "ask",
  transcription_max_concurrent: "1",
  transcription_path_map_from: "",
  transcription_path_map_to: "",
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
  output_pattern: "{{name}}.eng.srt",
  lang_code: "eng",
  enabled: 1,
  prompt_override: "",
  created_at: new Date().toISOString(),
};

// --- Load / Save ---

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
      if (!data._next_task_id) data._next_task_id = Math.max(0, ...data.tasks.map((t) => t.id)) + 1;
      return data;
    }
  } catch (e) {
    console.error("[Config] Failed to load config.json, using defaults:", e);
  }

  // First run — create with defaults
  const config: ConfigData = {
    settings: { ...DEFAULT_SETTINGS },
    tasks: [{ ...DEFAULT_TASK }],
    _next_task_id: 2,
  };
  saveConfig(config);
  return config;
}

function saveConfig(config: ConfigData): void {
  const tmpPath = `${CONFIG_FILE}.tmp`;
  const json = JSON.stringify(config, null, 2);
  fs.writeFileSync(tmpPath, json, "utf8");
  try {
    fs.renameSync(tmpPath, CONFIG_FILE);
  } catch {
    fs.writeFileSync(CONFIG_FILE, json, "utf8");
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// In-memory cache — loaded once, written on every mutation
let _config: ConfigData = loadConfig();

// --- Settings ---

export function getSetting(key: string): string {
  return _config.settings[key] ?? DEFAULT_SETTINGS[key] ?? "";
}

export function setSetting(key: string, value: string): void {
  _config.settings[key] = value;
  saveConfig(_config);
}

export function getAllSettings(): Record<string, string> {
  const merged = { ...DEFAULT_SETTINGS, ..._config.settings };
  // Backfill the connections array from legacy flat keys so the client and the
  // queue always see a populated list, even before the first multi-connection save.
  if (!merged.llm_connections || !merged.llm_connections.trim()) {
    merged.llm_connections = JSON.stringify(migrateConnectionsFromFlat(merged));
  }
  return merged;
}

// --- Translation Tasks ---

export function getTasks(): TranslationTask[] {
  return _config.tasks;
}

export function getTask(id: number): TranslationTask | undefined {
  return _config.tasks.find((t) => t.id === id);
}

export function createTask(task: {
  source_lang: string;
  target_lang: string;
  output_pattern: string;
  lang_code: string;
}): { lastInsertRowid: number } {
  const id = _config._next_task_id++;
  const newTask: TranslationTask = {
    id,
    source_lang: task.source_lang,
    target_lang: task.target_lang,
    output_pattern: task.output_pattern,
    lang_code: task.lang_code,
    enabled: 1,
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
  }>
): void {
  const task = _config.tasks.find((t) => t.id === id);
  if (!task) return;
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) {
      (task as any)[k] = v;
    }
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
