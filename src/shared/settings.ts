/**
 * Every setting the app stores, with the shape of its value. config.json and
 * the API carry settings as strings; this table says what each string must
 * be, so the server validates a save and reads a typed value from one place,
 * and the client can draw a numeric field's bounds from the same source.
 */
export type SettingSpec =
  | { kind: "string" }
  /** A string the API never returns in full: an API key, a webhook URL with its token. */
  | { kind: "secret" }
  /** "1" or "0". */
  | { kind: "flag" }
  | { kind: "int"; min: number; max: number }
  | { kind: "float"; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  /** A JSON document another module parses (connections, rules, playlists). */
  | { kind: "json" };

const s = { kind: "string" } as const;
const secret = { kind: "secret" } as const;
const flag = { kind: "flag" } as const;
const json = { kind: "json" } as const;
const int = (min: number, max: number) => ({ kind: "int", min, max }) as const;
const float = (min: number, max: number) => ({ kind: "float", min, max }) as const;
const oneOf = <const T extends readonly string[]>(values: T) => ({ kind: "enum", values }) as const;

export const SETTINGS = {
  // LLM
  llm_endpoint: s,
  api_key: secret,
  model: s,
  api_type: s,
  cloud_provider: oneOf(["local", "openai", "anthropic", "gemini"]),
  cloud_api_key_openai: secret,
  cloud_api_key_anthropic: secret,
  cloud_api_key_gemini: secret,
  cloud_model_openai: s,
  cloud_model_anthropic: s,
  cloud_model_gemini: s,
  llm_connections: json,
  llm_mode: oneOf(["single", "fallback", "parallel"]),
  active_connection_id: s,
  // Library
  scan_mode: oneOf(["recursive", "root_only", "selected"]),
  scan_folders: s,
  scan_exclude_folders: s,
  scan_profiles: json,
  directory_rules: json,
  translate_without_video: oneOf(["on", "off"]),
  // Translation engine
  temperature: float(0, 2),
  chunk_size: int(1, 500),
  context_window: int(0, 100),
  parallel_chunks: int(1, 8),
  request_timeout_s: int(10, 7200),
  disable_tool_calls: flag,
  refine_pass: flag,
  series_memory: flag,
  title_sidecar: flag,
  auto_scan_interval: int(0, 10080),
  monthly_token_budget: int(0, 1_000_000_000_000),
  // Notifications
  notify_webhook_url: secret,
  notify_events: s,
  notify_format: oneOf(["json", "discord", "slack"]),
  // Monitoring
  watch_enabled: flag,
  auto_translate: flag,
  video_extensions: s,
  subtitle_extensions: s,
  // Speech-to-text
  transcription_enabled: flag,
  transcription_backend_url: s,
  transcription_backend_token: secret,
  transcription_model: s,
  transcription_device: s,
  transcription_compute_type: s,
  transcription_language: s,
  preferred_chinese: oneOf(["zh-TW", "zh-CN"]),
  transcription_use_vad: flag,
  transcription_output_format: s,
  transcription_sort_by: oneOf(["name", "date"]),
  transcription_sort_dir: oneOf(["asc", "desc"]),
  dashboard_sort_by: oneOf(["name", "date"]),
  dashboard_sort_dir: oneOf(["asc", "desc"]),
  // 0 turns the limit off.
  transcription_max_line_length: int(0, 200),
  transcription_max_subtitle_duration: float(0, 60),
  transcription_merge_short_segments: flag,
  transcription_folder_defaults: json,
  transcription_advanced_stt: json,
  transcription_missing_subtitle_behavior: oneOf(["ask", "auto_transcribe", "auto_transcribe_and_translate"]),
  transcription_low_ram_behavior: oneOf(["ask", "downgrade", "skip", "run_anyway"]),
  transcription_max_concurrent: int(1, 4),
  transcription_request_timeout_s: int(30, 86400),
  transcription_path_map_from: s,
  transcription_path_map_to: s,
  transcription_transport: oneOf(["auto", "shared", "upload"]),
  gpu_shared: flag,
  // YouTube
  youtube_playlists: json,
  youtube_download_dir: s,
  youtube_notes_dir: s,
  youtube_api_key: secret,
  // Prompt
  additional_context: s,
  prompt: s,
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

/** The value a setting reads as once parsed: booleans for flags, numbers for numbers, unions for enums. */
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K] extends { kind: "flag" }
  ? boolean
  : (typeof SETTINGS)[K] extends { kind: "int" | "float" }
    ? number
    : (typeof SETTINGS)[K] extends { kind: "enum"; values: readonly (infer V)[] }
      ? V
      : string;

export type TypedSettings = { [K in SettingKey]: SettingValue<K> };

export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set(
  Object.entries(SETTINGS)
    .filter(([, spec]) => spec.kind === "secret")
    .map(([key]) => key),
);

const INTEGER_SYNTAX = /^-?\d+$/;
const DECIMAL_SYNTAX = /^-?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Why `value` is not a valid `key`, or null when it is (or when `key` is not
 * a setting at all, which the writable-key check reports separately).
 */
export function settingError(key: string, value: string): string | null {
  const spec = (SETTINGS as Record<string, SettingSpec>)[key];
  if (!spec) return null;
  switch (spec.kind) {
    case "flag":
      return value === "1" || value === "0" ? null : `${key} must be 1 or 0`;
    case "enum":
      return spec.values.includes(value) ? null : `${key} must be one of ${spec.values.join(", ")}`;
    case "int":
    case "float": {
      // Plain decimal only: readers use parseInt/parseFloat, which would read
      // "1e2" as 1 and "0x10" as 0, so anything Number() accepts but they do not
      // would pass here and mean something else at runtime.
      const syntax = spec.kind === "int" ? INTEGER_SYNTAX : DECIMAL_SYNTAX;
      const parsed = syntax.test(value) ? Number(value) : NaN;
      if (Number.isFinite(parsed) && parsed >= spec.min && parsed <= spec.max) return null;
      return `${key} must be ${spec.kind === "int" ? "a whole number" : "a number"} from ${spec.min} to ${spec.max}`;
    }
    case "json":
      try {
        JSON.parse(value);
        return null;
      } catch {
        return `${key} must be valid JSON`;
      }
    default:
      return null;
  }
}
