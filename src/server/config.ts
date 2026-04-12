import fs from "node:fs";
import path from "node:path";

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

// --- Defaults ---

const DEFAULT_SETTINGS: Record<string, string> = {
  llm_endpoint: "http://localhost:8000/v1",
  api_key: "",
  model: "Qwen/Qwen2.5-72B-Instruct",
  api_type: "openai",
  scan_mode: "recursive",
  scan_folders: "",
  scan_exclude_folders: "",
  scan_profiles: "[]",
  temperature: "0.7",
  chunk_size: "20",
  context_window: "5",
  auto_scan_interval: "0",
  watch_enabled: "0",
  auto_translate: "1",
  video_extensions: ".mkv,.mp4,.avi,.m4v,.ts,.wmv,.mov",
  subtitle_extensions: ".srt,.ass,.ssa,.vtt",
  additional_context: "",
  prompt: `// You are a professional subtitle translator.
// You will only receive subtitles and are only required to translate, no need for any replies.
// Note: {{additional}}
// Do not merge sentences, translate them individually.
// Return the translated subtitles in the same order and length as the input.
// 1. Parse the input subtitles
// 2. Translate the input subtitles into {{lang}}
// 3. Convert names into {{lang}}
// 4. Paraphrase the translated subtitles into more fluent sentences
// 5. Use the setResult method to output the translated subtitles as string[]`,
};

const DEFAULT_TASK: TranslationTask = {
  id: 1,
  source_lang: "English",
  target_lang: "Traditional Chinese (Taiwan)",
  output_pattern: "{{name}}.chi.srt",
  lang_code: "chi",
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
  return { ...DEFAULT_SETTINGS, ..._config.settings };
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
