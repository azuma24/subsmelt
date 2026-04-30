import path from "node:path";

export const transcribePostActionValues = ["transcribe_only", "transcribe_and_translate"] as const;
export type TranscribePostAction = typeof transcribePostActionValues[number];
export type TranscriptionOutputFormat = "srt" | "vtt" | "txt";
export type LowRamBehavior = "ask" | "downgrade" | "skip" | "run_anyway";

export interface TranscriptionSettings {
  transcription_backend_url?: string;
  transcription_model?: string;
  transcription_device?: string;
  transcription_compute_type?: string;
  transcription_language?: string;
  transcription_use_vad?: string;
  transcription_output_format?: string;
  transcription_low_ram_behavior?: string;
  transcription_path_map_from?: string;
  transcription_path_map_to?: string;
  transcription_max_line_length?: string;
  transcription_max_subtitle_duration?: string;
  transcription_merge_short_segments?: string;
  transcription_folder_defaults?: string;
  transcription_advanced_stt?: string;
}

export interface TranscriptionFolderDefaults {
  path?: string;
  model?: string;
  language?: string;
  device?: string;
  compute_type?: string;
  output_format?: string;
  use_vad?: boolean | string;
  max_line_length?: number | string;
  max_subtitle_duration?: number | string;
  merge_short_segments?: boolean | string;
  advanced_options?: TranscriptionAdvancedOptions;
}

export interface TranscriptionAdvancedOptions {
  beam_size?: number;
  patience?: number;
  condition_on_previous_text?: boolean;
  word_timestamps?: boolean;
  initial_prompt?: string;
  speaker_diarization?: boolean;
  bgm_separation?: boolean;
}

export interface BuildTranscriptionRequestOptions {
  videoPath: string;
  mediaDir: string;
  settings: TranscriptionSettings;
  outputFormat?: TranscriptionOutputFormat;
  postAction?: TranscribePostAction;
}

export interface BackendTranscriptionRequest {
  input_path: string;
  output_format: TranscriptionOutputFormat;
  model: string;
  language: string;
  device: string;
  compute_type: string;
  use_vad: boolean;
  post_action: TranscribePostAction;
  allow_unsafe?: boolean;
  subtitle_quality?: TranscriptionSubtitleQualityOptions;
  advanced_options?: TranscriptionAdvancedOptions;
}

export interface TranscriptionSubtitleQualityOptions {
  max_line_length?: number;
  max_subtitle_duration?: number;
  merge_short_segments?: boolean;
}

export interface BackendPreflightResponse {
  ok?: boolean;
  safe?: boolean;
  code?: string;
  availableRamMb?: number;
  requiredRamMb?: number;
  recommendedRamMb?: number;
  suggestedModel?: string | null;
  ffmpegAvailable?: boolean;
  diskAvailableMb?: number;
  requiredDiskMb?: number;
  modelCache?: {
    model?: string;
    cached?: boolean | null;
    cacheRoot?: string;
    cachePath?: string | null;
    firstRunDownloadExpected?: boolean;
    requiredRamMb?: number;
    recommendedRamMb?: number;
    suggestedModel?: string | null;
    warning?: string;
  };
}

export interface BackendTranscriptionResponse {
  ok: boolean;
  subtitle_path?: string;
  language?: string;
  segments?: number;
  duration_seconds?: number;
  error?: string;
  detail?: unknown;
}

export function normalizeTranscriptionBackendUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function assertMediaPathAllowed(inputPath: string, mediaDir: string): string {
  const mediaRoot = path.resolve(mediaDir);
  const resolved = path.resolve(inputPath);
  if (resolved !== mediaRoot && !resolved.startsWith(`${mediaRoot}${path.sep}`)) {
    throw new Error(`Transcription input is outside media directory: ${inputPath}`);
  }
  return resolved;
}

function assertAbsoluteFilesystemPrefix(rawPath: string, label: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error(`${label} is required when transcription path mapping is enabled`);
  if (!path.isAbsolute(trimmed)) throw new Error(`${label} must be an absolute filesystem path`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.includes("@")) {
    throw new Error(`${label} must be an absolute filesystem path without credentials or URLs`);
  }

  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  if (segments.includes(".") || segments.includes("..")) {
    throw new Error(`${label} must not contain traversal segments`);
  }

  return path.resolve(trimmed);
}

function mapPathForBackend(inputPath: string, settings: TranscriptionSettings): string {
  const rawFrom = settings.transcription_path_map_from?.trim() ?? "";
  const rawTo = settings.transcription_path_map_to?.trim() ?? "";
  if (!rawFrom && !rawTo) return inputPath;
  if (!rawFrom || !rawTo) {
    throw new Error("Both transcription path mapping fields are required when path mapping is enabled");
  }

  const fromPrefix = assertAbsoluteFilesystemPrefix(rawFrom, "transcription_path_map_from");
  const toPrefix = assertAbsoluteFilesystemPrefix(rawTo, "transcription_path_map_to");
  if (inputPath !== fromPrefix && !inputPath.startsWith(`${fromPrefix}${path.sep}`)) {
    throw new Error(`Transcription input does not match configured mapping prefix: ${inputPath}`);
  }

  const relativeSuffix = path.relative(fromPrefix, inputPath);
  const mappedPath = relativeSuffix ? path.join(toPrefix, relativeSuffix) : toPrefix;
  if (!path.isAbsolute(mappedPath)) {
    throw new Error("Mapped transcription path must be an absolute filesystem path");
  }
  if (mappedPath !== toPrefix && !mappedPath.startsWith(`${toPrefix}${path.sep}`)) {
    throw new Error("Mapped transcription path escapes the configured backend prefix");
  }
  return mappedPath;
}

function setting(raw: string | undefined, fallback: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || fallback;
}

function boolSetting(raw: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

function outputFormat(raw: string | undefined, fallback: TranscriptionOutputFormat): TranscriptionOutputFormat {
  return raw === "vtt" || raw === "txt" || raw === "srt" ? raw : fallback;
}

function lowRamBehavior(raw: string | undefined): LowRamBehavior {
  return raw === "downgrade" || raw === "skip" || raw === "run_anyway" ? raw : "ask";
}

function intSetting(raw: string | number | undefined): number | undefined {
  const value = typeof raw === "number" ? raw : Number.parseInt((raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function floatSetting(raw: string | number | undefined): number | undefined {
  const value = typeof raw === "number" ? raw : Number.parseFloat((raw || "").trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function subtitleQualitySettings(settings: TranscriptionSettings, folderDefaults?: TranscriptionFolderDefaults): TranscriptionSubtitleQualityOptions | undefined {
  const maxLineLength = intSetting(folderDefaults?.max_line_length ?? settings.transcription_max_line_length);
  const maxSubtitleDuration = floatSetting(folderDefaults?.max_subtitle_duration ?? settings.transcription_max_subtitle_duration);
  const mergeShortSegments = boolSetting(folderDefaults?.merge_short_segments ?? settings.transcription_merge_short_segments, false);
  if (
    maxLineLength === undefined &&
    maxSubtitleDuration === undefined &&
    !mergeShortSegments
  ) {
    return undefined;
  }
  return {
    ...(maxLineLength !== undefined ? { max_line_length: maxLineLength } : {}),
    ...(maxSubtitleDuration !== undefined ? { max_subtitle_duration: maxSubtitleDuration } : {}),
    ...(mergeShortSegments ? { merge_short_segments: true } : {}),
  };
}

function parseJsonObject<T>(raw: string | undefined, fallback: T, label = "JSON setting"): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as T : fallback;
  } catch {
    throw new Error(`Invalid ${label} JSON`);
  }
}

export function localTranscriptionOutputPath(inputPath: string, language: string, outputFormat: TranscriptionOutputFormat): string {
  const parsed = path.parse(inputPath);
  const suffix = !language || language === "auto" ? outputFormat : `${language}.${outputFormat}`;
  return path.join(parsed.dir, `${parsed.name}.${suffix}`);
}

function matchingFolderDefaults(inputPath: string, mediaDir: string, settings: TranscriptionSettings): TranscriptionFolderDefaults | undefined {
  const entries = parseJsonObject<unknown>(settings.transcription_folder_defaults, [], "transcription_folder_defaults");
  if (!Array.isArray(entries)) return undefined;

  const mediaRoot = path.resolve(mediaDir);
  const candidates = entries
    .filter((entry): entry is TranscriptionFolderDefaults => Boolean(entry && typeof entry === "object" && typeof (entry as TranscriptionFolderDefaults).path === "string"))
    .map((entry) => ({ ...entry, path: path.resolve(String(entry.path)) }))
    .filter((entry) => {
      const folderPath = String(entry.path);
      return (folderPath === mediaRoot || folderPath.startsWith(`${mediaRoot}${path.sep}`))
        && (inputPath === folderPath || inputPath.startsWith(`${folderPath}${path.sep}`));
    })
    .sort((a, b) => String(b.path).length - String(a.path).length);

  return candidates[0];
}

function advancedSttOptions(settings: TranscriptionSettings, folderDefaults?: TranscriptionFolderDefaults): TranscriptionAdvancedOptions | undefined {
  const globalOptions = parseJsonObject<TranscriptionAdvancedOptions>(settings.transcription_advanced_stt, {}, "transcription_advanced_stt");
  const merged: TranscriptionAdvancedOptions = { ...globalOptions, ...(folderDefaults?.advanced_options || {}) };
  const beamSize = intSetting(merged.beam_size);
  const patience = floatSetting(merged.patience);
  const initialPrompt = typeof merged.initial_prompt === "string" ? merged.initial_prompt.trim() : "";
  const result: TranscriptionAdvancedOptions = {
    ...(beamSize !== undefined ? { beam_size: beamSize } : {}),
    ...(patience !== undefined ? { patience } : {}),
    ...(typeof merged.condition_on_previous_text === "boolean" ? { condition_on_previous_text: merged.condition_on_previous_text } : {}),
    ...(typeof merged.word_timestamps === "boolean" ? { word_timestamps: merged.word_timestamps } : {}),
    ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
    ...(typeof merged.speaker_diarization === "boolean" ? { speaker_diarization: merged.speaker_diarization } : {}),
    ...(typeof merged.bgm_separation === "boolean" ? { bgm_separation: merged.bgm_separation } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

export function buildTranscriptionRequest(options: BuildTranscriptionRequestOptions): BackendTranscriptionRequest {
  const localInputPath = assertMediaPathAllowed(options.videoPath, options.mediaDir);
  const folderDefaults = matchingFolderDefaults(localInputPath, options.mediaDir, options.settings);
  const backendInputPath = mapPathForBackend(localInputPath, options.settings);
  const requestedAction = options.postAction ?? "transcribe_only";
  const postAction = transcribePostActionValues.includes(requestedAction) ? requestedAction : "transcribe_only";
  const subtitleQuality = subtitleQualitySettings(options.settings, folderDefaults);
  const advancedOptions = advancedSttOptions(options.settings, folderDefaults);

  return {
    input_path: backendInputPath,
    output_format: options.outputFormat ?? outputFormat(folderDefaults?.output_format ?? options.settings.transcription_output_format, "srt"),
    model: setting(folderDefaults?.model ?? options.settings.transcription_model, "small"),
    language: setting(folderDefaults?.language ?? options.settings.transcription_language, "auto"),
    device: setting(folderDefaults?.device ?? options.settings.transcription_device, "cpu"),
    compute_type: setting(folderDefaults?.compute_type ?? options.settings.transcription_compute_type, "int8"),
    use_vad: boolSetting(folderDefaults?.use_vad ?? options.settings.transcription_use_vad, true),
    post_action: postAction,
    ...(subtitleQuality ? { subtitle_quality: subtitleQuality } : {}),
    ...(advancedOptions ? { advanced_options: advancedOptions } : {}),
  };
}

function backendErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const detail = record.detail;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).message === "string") {
      return String((detail as Record<string, unknown>).message);
    }
  }
  return `Transcription backend returned HTTP ${status}`;
}

export async function fetchTranscriptionHealth(backendUrl: string, model?: string): Promise<unknown> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const qs = model ? `?${new URLSearchParams({ model }).toString()}` : "";
  const response = await fetch(`${url}/health${qs}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(backendErrorMessage(body, response.status));
  return body;
}

export async function preflightTranscription(backendUrl: string, request: BackendTranscriptionRequest): Promise<BackendPreflightResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetch(`${url}/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(backendErrorMessage(body, response.status));
  return body as BackendPreflightResponse;
}

export async function applyPreflightPolicy(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  settings: TranscriptionSettings,
): Promise<BackendTranscriptionRequest> {
  const preflight = await preflightTranscription(backendUrl, request);
  if (preflight.safe !== false && preflight.ok !== false) return request;

  if (preflight.code === "insufficient_ram") {
    const behavior = lowRamBehavior(settings.transcription_low_ram_behavior);
    if (behavior === "downgrade" && preflight.suggestedModel && preflight.suggestedModel !== request.model) {
      const downgraded = { ...request, model: preflight.suggestedModel };
      const downgradedPreflight = await preflightTranscription(backendUrl, downgraded);
      if (downgradedPreflight.safe !== false && downgradedPreflight.ok !== false) return downgraded;
    }
    if (behavior === "run_anyway") return { ...request, allow_unsafe: true };
    if (behavior === "skip") {
      throw new Error(`Transcription skipped: insufficient RAM (${preflight.availableRamMb ?? "unknown"} MB available, ${preflight.requiredRamMb ?? "unknown"} MB required)`);
    }
    throw new Error(`Not enough RAM for ${request.model}; available ${preflight.availableRamMb ?? "unknown"} MB, required ${preflight.requiredRamMb ?? "unknown"} MB`);
  }

  if (preflight.code === "insufficient_disk") {
    throw new Error(`Not enough disk space for transcription; available ${preflight.diskAvailableMb ?? "unknown"} MB, required ${preflight.requiredDiskMb ?? "unknown"} MB`);
  }

  throw new Error(`Transcription preflight failed: ${preflight.code || "unsafe"}`);
}

export async function transcribeWithBackend(backendUrl: string, request: BackendTranscriptionRequest): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetch(`${url}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(backendErrorMessage(body, response.status));
  return body as BackendTranscriptionResponse;
}
