/**
 * Client-side typed view over the settings the server stores as
 * `Record<string, string>` (see src/server/config.ts DEFAULT_SETTINGS).
 *
 * The server's wire format is unchanged: settings are sent and received as a
 * flat map of string values. This module provides:
 *
 *   - `ClientSettings`: a typed, partial view of the known setting keys. It is
 *     deliberately a *view*, not a rewrite — most values are strings the server
 *     expects verbatim, and several are "0"/"1" string-booleans kept as strings
 *     so the save payload shape never changes.
 *   - `getStr` / `getBool`: safe accessors that replace the inline `str()` /
 *     `bool()` coercers previously defined in SettingsPage.
 *   - `validateJsonSetting`: pre-save validation for the two JSON-blob settings
 *     (`transcription_folder_defaults` must parse to an array;
 *     `transcription_advanced_stt` must parse to an object).
 */

/**
 * String-boolean: the server stores certain toggles as the literal strings
 * "0" (off) and "1" (on). Kept as strings so the wire format is preserved.
 */
export type StringBool = "0" | "1";

/**
 * Typed view of the known client settings. Every field is optional because the
 * server may omit keys (defaults are merged server-side) and the client also
 * carries a few transient, non-persisted underscore-prefixed keys.
 *
 * NOTE: This is a structural superset used for reads only. The actual state and
 * save payload remain `Record<string, unknown>` / `Record<string, string>` so
 * the existing autosave/debounce logic and the server wire format are untouched.
 */
export interface ClientSettings {
  // ── LLM connection ──
  llm_endpoint?: string;
  api_key?: string;
  model?: string;
  api_type?: string;
  cloud_provider?: string;
  cloud_api_key_openai?: string;
  cloud_api_key_anthropic?: string;
  cloud_api_key_gemini?: string;
  cloud_model_openai?: string;
  cloud_model_anthropic?: string;
  cloud_model_gemini?: string;
  llm_connections?: string; // JSON array of connections
  llm_mode?: string; // "single" | "fallback" | "parallel"
  active_connection_id?: string;

  // ── Sources & monitoring ──
  scan_mode?: string;
  scan_folders?: string;
  scan_exclude_folders?: string;
  scan_profiles?: string; // JSON array
  directory_rules?: string; // JSON array
  translate_without_video?: string; // "on" | "off"
  auto_scan_interval?: string;
  monthly_token_budget?: string;
  watch_enabled?: StringBool;
  auto_translate?: StringBool;
  video_extensions?: string;
  subtitle_extensions?: string;

  // ── Translation engine ──
  temperature?: string;
  chunk_size?: string;
  context_window?: string;
  parallel_chunks?: string;
  request_timeout_s?: string;
  disable_tool_calls?: StringBool;
  refine_pass?: StringBool;
  series_memory?: StringBool;
  additional_context?: string;
  prompt?: string;

  // ── Speech-to-text ──
  transcription_enabled?: StringBool;
  transcription_backend_url?: string;
  transcription_model?: string;
  transcription_device?: string;
  transcription_compute_type?: string;
  transcription_language?: string;
  transcription_use_vad?: StringBool;
  transcription_output_format?: string;
  transcription_max_line_length?: string;
  transcription_max_subtitle_duration?: string;
  transcription_merge_short_segments?: StringBool;
  /** JSON array of per-folder STT default objects. Default "[]". */
  transcription_folder_defaults?: string;
  /** JSON object of advanced faster-whisper options. Default "{}". */
  transcription_advanced_stt?: string;
  transcription_missing_subtitle_behavior?: string;
  transcription_low_ram_behavior?: string;
  transcription_max_concurrent?: string;
  transcription_path_map_from?: string;
  transcription_path_map_to?: string;
  transcription_transport?: string;

  // ── Transient / server-injected, not persisted by the client ──
  _watcher_running?: boolean;
  _media_dir?: string;

  // Forward-compatible: tolerate keys the client doesn't yet model.
  [key: string]: unknown;
}

/** The two settings whose values are JSON blobs validated before save. */
export const JSON_BLOB_SETTINGS = {
  transcription_folder_defaults: "array",
  transcription_advanced_stt: "object",
} as const;

export type JsonBlobSettingKey = keyof typeof JSON_BLOB_SETTINGS;

export type JsonValidation = { ok: true } | { ok: false; error: string };

/** Type guard for the two JSON-blob setting keys. */
export function isJsonBlobSetting(key: string): key is JsonBlobSettingKey {
  return Object.prototype.hasOwnProperty.call(JSON_BLOB_SETTINGS, key);
}

/**
 * Safe string accessor. Replaces the inline `str()` coercer: returns the value
 * when it's a string, otherwise the provided fallback.
 */
export function getStr(settings: ClientSettings, key: string, fallback = ""): string {
  const v = settings[key];
  return typeof v === "string" ? v : fallback;
}

/**
 * Boolean accessor. The codebase stores toggles two ways:
 *   - as the string "1"/"0" (persisted settings), or
 *   - as a real boolean (transient keys like `_watcher_running`).
 *
 * `getBool` normalizes both: "1" → true, "0"/anything-else → false; real
 * booleans pass through. This subsumes the old `bool()` helper while also
 * correctly reading the string-boolean settings.
 */
export function getBool(settings: ClientSettings, key: string, fallback = false): boolean {
  const v = settings[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "1";
  return fallback;
}

/**
 * Validate a JSON-blob setting BEFORE persisting it.
 *
 * - `transcription_folder_defaults` must parse to a JSON array.
 * - `transcription_advanced_stt` must parse to a JSON object (not array/null).
 * - Empty / whitespace-only input is treated as valid: callers normalize it to
 *   the server default ("[]" / "{}") on save, matching existing behavior.
 *
 * Any key that is not a JSON-blob setting is considered valid (nothing to check).
 */
export function validateJsonSetting(key: string, value: string): JsonValidation {
  if (!isJsonBlobSetting(key)) return { ok: true };

  const expected = JSON_BLOB_SETTINGS[key];
  const trimmed = value.trim();
  // Empty is allowed — treated as the default container on save.
  if (trimmed === "") return { ok: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `invalidJson:${detail}` };
  }

  if (expected === "array") {
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "expectedArray" };
    }
    return { ok: true };
  }

  // expected === "object"
  const isPlainObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  if (!isPlainObject) {
    return { ok: false, error: "expectedObject" };
  }
  return { ok: true };
}
