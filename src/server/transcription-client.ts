import { openAsBlob } from "node:fs";
import path from "node:path";

export const transcribePostActionValues = ["transcribe_only", "transcribe_and_translate"] as const;
export type TranscribePostAction = typeof transcribePostActionValues[number];
export type TranscriptionOutputFormat = "srt" | "vtt" | "txt" | "ass";
export type LowRamBehavior = "ask" | "downgrade" | "skip" | "run_anyway";

// Short timeout (ms) for lightweight backend calls (health, preflight).
const SHORT_REQUEST_TIMEOUT_MS = 10_000;
// Default timeout (ms) for /transcribe when no setting is supplied (30 minutes).
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 1_800_000;

/**
 * Runs fetch with an AbortController-based timeout. On timeout, throws a clear
 * "<label> timed out after Ns" error instead of hanging Node forever.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface TranscriptionSettings {
  transcription_backend_url?: string;
  transcription_backend_token?: string;
  transcription_model?: string;
  transcription_device?: string;
  transcription_compute_type?: string;
  transcription_language?: string;
  transcription_use_vad?: string;
  transcription_output_format?: string;
  transcription_low_ram_behavior?: string;
  transcription_path_map_from?: string;
  transcription_path_map_to?: string;
  transcription_transport?: string;
  transcription_request_timeout_s?: string;
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

// Per-run overrides that win over the global Settings values (Whisper page lets
// the user pick model/device/compute/language for a specific batch).
export interface TranscriptionOverrides {
  model?: string;
  language?: string;
  device?: string;
  compute_type?: string;
  // Per-run speaker diarization toggle (Whisper page). Merged into
  // advanced_options so it wins over per-folder / global advanced_stt.
  speaker_diarization?: boolean;
}

export interface BuildTranscriptionRequestOptions {
  videoPath: string;
  mediaDir: string;
  settings: TranscriptionSettings;
  outputFormat?: TranscriptionOutputFormat;
  postAction?: TranscribePostAction;
  overrides?: TranscriptionOverrides;
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
  // Path mode (Model A): backend wrote the subtitle to a shared path.
  subtitle_path?: string;
  // Upload mode (Model B): backend returns the subtitle content; the SubSmelt
  // server writes it to the local output path.
  content?: string;
  language?: string;
  segments?: number;
  duration_seconds?: number;
  error?: string;
  detail?: unknown;
}

export type TranscriptionTransportMode = "shared" | "upload";

/**
 * Resolves which file transport to use (plan Phase 2).
 *
 * - "shared"/"upload" in settings force that mode.
 * - "auto" (default): upload when a token is configured but no path mapping is
 *   set — the remote Windows-server case where no shared filesystem exists.
 *   Otherwise shared path mode (local same-host / Docker volume, or an explicit
 *   path mapping that resolves on the backend), preserving prior behaviour.
 */
export function resolveTransportMode(settings: TranscriptionSettings): TranscriptionTransportMode {
  const explicit = (settings.transcription_transport || "").trim().toLowerCase();
  if (explicit === "shared" || explicit === "upload") return explicit;

  const hasMapping = Boolean(
    settings.transcription_path_map_from?.trim() && settings.transcription_path_map_to?.trim(),
  );
  const hasToken = Boolean(settings.transcription_backend_token?.trim());
  return hasToken && !hasMapping ? "upload" : "shared";
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
  return raw === "vtt" || raw === "txt" || raw === "srt" || raw === "ass" ? raw : fallback;
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
  // Per-run overrides (Whisper page) win over per-folder defaults and global
  // settings. setting() ignores empty/whitespace, so an unset override falls
  // through to the existing precedence cleanly.
  const ov = options.overrides ?? {};
  // A per-run diarize toggle merges into advanced_options (creating it if the
  // settings produced none) so it overrides the global advanced_stt value.
  const mergedAdvanced =
    ov.speaker_diarization === true
      ? { ...(advancedOptions ?? {}), speaker_diarization: true }
      : ov.speaker_diarization === false
        ? { ...(advancedOptions ?? {}), speaker_diarization: false }
        : advancedOptions;

  return {
    input_path: backendInputPath,
    output_format: options.outputFormat ?? outputFormat(folderDefaults?.output_format ?? options.settings.transcription_output_format, "srt"),
    model: setting(ov.model ?? folderDefaults?.model ?? options.settings.transcription_model, "small"),
    language: setting(ov.language ?? folderDefaults?.language ?? options.settings.transcription_language, "auto"),
    device: setting(ov.device ?? folderDefaults?.device ?? options.settings.transcription_device, "cpu"),
    compute_type: setting(ov.compute_type ?? folderDefaults?.compute_type ?? options.settings.transcription_compute_type, "int8"),
    use_vad: boolSetting(folderDefaults?.use_vad ?? options.settings.transcription_use_vad, true),
    post_action: postAction,
    ...(subtitleQuality ? { subtitle_quality: subtitleQuality } : {}),
    ...(mergedAdvanced ? { advanced_options: mergedAdvanced } : {}),
  };
}

// Phase 1 remote hardening: when a shared-secret token is configured it is sent
// as `Authorization: Bearer <token>` on every backend call. An empty/whitespace
// token means no header (localhost dev default), matching the backend which
// disables auth when SUBSMELT_WHISPER_TOKEN is unset.
export function transcriptionAuthHeaders(token: string | undefined): Record<string, string> {
  const value = typeof token === "string" ? token.trim() : "";
  return value ? { Authorization: `Bearer ${value}` } : {};
}

// Clear, actionable message when the backend rejects the configured token so the
// user is pointed straight at the setting to fix.
const TOKEN_REJECTED_MESSAGE =
  "Whisper backend rejected the token — check Transcription backend token in Settings";

// Throws the standard 401 message; otherwise returns the generic backend error.
// Centralizes 401 handling so every backend call surfaces the same guidance.
function throwBackendError(body: unknown, status: number): never {
  const err = status === 401 ? new Error(TOKEN_REJECTED_MESSAGE) : new Error(backendErrorMessage(body, status));
  // Carry the backend HTTP status so callers can map a 5xx upstream failure to a
  // 502 (instead of relying on message-text heuristics that drop the status).
  (err as Error & { backendStatus?: number }).backendStatus = status;
  throw err;
}

function backendErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const detail = record.detail;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      const d = detail as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
      // Some backend errors carry a structured code but no message (e.g. the
      // 409 model_not_downloaded shape {code, model}). Render an actionable line
      // instead of falling through to the useless "HTTP <status>" generic.
      if (d.code === "model_not_downloaded" && typeof d.model === "string") {
        return `Model "${d.model}" is not downloaded — download it in Settings → Speech to Text → Whisper Models first`;
      }
      if (typeof d.code === "string") return `Transcription failed (${d.code})`;
    }
  }
  return `Transcription backend returned HTTP ${status}`;
}

export async function fetchTranscriptionHealth(backendUrl: string, model?: string, token?: string): Promise<unknown> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const qs = model ? `?${new URLSearchParams({ model }).toString()}` : "";
  const response = await fetchWithTimeout(`${url}/health${qs}`, {
    headers: { ...transcriptionAuthHeaders(token) },
  }, SHORT_REQUEST_TIMEOUT_MS, "Transcription backend health check");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body;
}

export async function preflightTranscription(backendUrl: string, request: BackendTranscriptionRequest, token?: string): Promise<BackendPreflightResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(`${url}/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(token) },
    body: JSON.stringify(request),
  }, SHORT_REQUEST_TIMEOUT_MS, "Transcription backend preflight");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as BackendPreflightResponse;
}

export async function applyPreflightPolicy(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  settings: TranscriptionSettings,
): Promise<BackendTranscriptionRequest> {
  const token = settings.transcription_backend_token;
  const preflight = await preflightTranscription(backendUrl, request, token);
  if (preflight.safe !== false && preflight.ok !== false) return request;

  if (preflight.code === "insufficient_ram") {
    const behavior = lowRamBehavior(settings.transcription_low_ram_behavior);
    if (behavior === "downgrade" && preflight.suggestedModel && preflight.suggestedModel !== request.model) {
      const downgraded = { ...request, model: preflight.suggestedModel };
      const downgradedPreflight = await preflightTranscription(backendUrl, downgraded, token);
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

export interface TranscribeBackendOptions {
  // Total request timeout in seconds. Falls back to the 30-minute default.
  timeoutSeconds?: number;
  // Optional shared-secret token sent as `Authorization: Bearer <token>`.
  token?: string;
}

function resolveTranscribeTimeoutMs(timeoutSeconds: number | undefined): number {
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return Math.round(timeoutSeconds * 1000);
  }
  return DEFAULT_TRANSCRIBE_TIMEOUT_MS;
}

export async function transcribeWithBackend(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  options?: TranscribeBackendOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const response = await fetchWithTimeout(`${url}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
    body: JSON.stringify(request),
  }, timeoutMs, "Transcription backend");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as BackendTranscriptionResponse;
}

export interface TranscriptionProgressUpdate {
  pct: number;
  processedSeconds: number;
  totalSeconds: number;
}

export interface TranscribeStreamingOptions extends TranscribeBackendOptions {
  // Called once per backend progress line.
  onProgress?: (update: TranscriptionProgressUpdate) => void;
  // Called on a backend phase line (e.g. "diarizing") for a live status hint.
  onPhase?: (phase: string) => void;
  // Aborting this signal closes the HTTP stream → backend detects the
  // disconnect → stops iterating segments and aborts the run.
  signal?: AbortSignal;
}

// Sentinel thrown when the stream endpoint is absent (older backend) so callers
// can transparently fall back to the non-streaming JSON endpoint.
export class StreamingUnsupportedError extends Error {
  constructor(message = "Streaming transcription endpoint is unavailable") {
    super(message);
    this.name = "StreamingUnsupportedError";
  }
}

function parseNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toProgressUpdate(record: Record<string, unknown>): TranscriptionProgressUpdate | null {
  const pct = typeof record.pct === "number" ? record.pct : undefined;
  const processedSeconds = typeof record.processedSeconds === "number" ? record.processedSeconds : undefined;
  const totalSeconds = typeof record.totalSeconds === "number" ? record.totalSeconds : undefined;
  if (pct === undefined || processedSeconds === undefined || totalSeconds === undefined) return null;
  return { pct, processedSeconds, totalSeconds };
}

/**
 * POSTs to /transcribe/stream and consumes the NDJSON line protocol. Progress
 * lines invoke onProgress; the terminal "result" line resolves the promise; an
 * "error" line throws. If the endpoint returns 404 (older backend without the
 * stream route) a StreamingUnsupportedError is thrown so the caller can fall
 * back to transcribeWithBackend. The passed AbortSignal cancels the request.
 */
export async function transcribeWithBackendStreaming(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  options?: TranscribeStreamingOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");

  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`${url}/transcribe/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Transcription cancelled");
    }
    throw error;
  }

  if (response.status === 404) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throw new StreamingUnsupportedError();
  }
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throwBackendError(body, response.status);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: BackendTranscriptionResponse | null = null;
  let streamError: string | null = null;

  const handleLine = (line: string): void => {
    const record = parseNdjsonLine(line);
    if (!record) return;
    const type = record.type;
    if (type === "progress") {
      const update = toProgressUpdate(record);
      if (update && options?.onProgress) options.onProgress(update);
    } else if (type === "phase") {
      if (typeof record.phase === "string" && options?.onPhase) options.onPhase(record.phase);
    } else if (type === "result") {
      const { type: _t, ...rest } = record;
      result = rest as unknown as BackendTranscriptionResponse;
    } else if (type === "error") {
      streamError = typeof record.error === "string" ? record.error : "Transcription failed";
    }
  };

  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Transcription cancelled");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }

  if (streamError) throw new Error(streamError);
  if (!result) throw new Error("Transcription stream ended without a result");
  return result;
}

// ======== Upload transport (Model B, plan Phase 2) ========
// The media bytes are uploaded as multipart instead of pointing the backend at a
// shared path; the backend returns subtitle CONTENT which the caller writes
// locally. `openAsBlob` streams the file from disk (no full in-memory copy).

// Builds the multipart body: the request JSON (minus input_path, which is
// meaningless server-side in upload mode) plus the media file.
async function buildUploadForm(request: BackendTranscriptionRequest, filePath: string): Promise<FormData> {
  const { input_path: _ignored, ...rest } = request;
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  form.append("request", JSON.stringify(rest));
  form.append("file", blob, path.basename(filePath));
  return form;
}

// Parses an NDJSON transcription stream (shared by upload streaming below).
// Progress lines drive onProgress; the terminal "result" line is returned; an
// "error" line throws. Mirrors the consumer in transcribeWithBackendStreaming.
async function consumeTranscriptionNdjson(
  body: ReadableStream<Uint8Array>,
  onProgress?: (update: TranscriptionProgressUpdate) => void,
  onPhase?: (phase: string) => void,
  // Optional abort signal so a cancelled run surfaces "Transcription cancelled"
  // rather than the generic "ended without result" when the stream is torn down.
  signal?: AbortSignal,
): Promise<BackendTranscriptionResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let result: BackendTranscriptionResponse | null = null;
  let streamError: string | null = null;

  const handleLine = (line: string): void => {
    const record = parseNdjsonLine(line);
    if (!record) return;
    const type = record.type;
    if (type === "progress") {
      const update = toProgressUpdate(record);
      if (update && onProgress) onProgress(update);
    } else if (type === "phase") {
      if (typeof record.phase === "string" && onPhase) onPhase(record.phase);
    } else if (type === "result") {
      const { type: _t, ...rest } = record;
      result = rest as unknown as BackendTranscriptionResponse;
    } else if (type === "error") {
      streamError = typeof record.error === "string" ? record.error : "Transcription failed";
    }
  };

  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } catch (error: unknown) {
    // Aborting the request rejects the stream iterator with AbortError; surface
    // it as the standard cancellation message instead of leaking a raw error.
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Transcription cancelled");
    }
    throw error;
  }

  if (streamError) throw new Error(streamError);
  if (!result) {
    // The stream ended cleanly without a result line. If an abort was involved
    // (race where iteration finished as the signal fired), report cancellation
    // rather than a confusing "ended without result".
    if (signal?.aborted) throw new Error("Transcription cancelled");
    throw new Error("Transcription stream ended without a result");
  }
  return result;
}

/**
 * Upload transport, non-streaming: POSTs the media file + request to
 * /transcribe/upload and returns the response carrying subtitle `content`.
 */
export async function transcribeWithBackendUpload(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  filePath: string,
  options?: TranscribeBackendOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const form = await buildUploadForm(request, filePath);
  const response = await fetchWithTimeout(`${url}/transcribe/upload`, {
    method: "POST",
    headers: { ...transcriptionAuthHeaders(options?.token) },
    body: form,
  }, timeoutMs, "Transcription backend upload");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as BackendTranscriptionResponse;
}

/**
 * Upload transport, streaming: POSTs the media file + request to
 * /transcribe/upload/stream and consumes the NDJSON progress protocol. Aborting
 * the signal closes the stream → backend cancels. A 404 (older backend without
 * the upload route) throws StreamingUnsupportedError so callers can react.
 */
export async function transcribeWithBackendUploadStreaming(
  backendUrl: string,
  request: BackendTranscriptionRequest,
  filePath: string,
  options?: TranscribeStreamingOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");

  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const form = await buildUploadForm(request, filePath);
  let response: Response;
  try {
    response = await fetch(`${url}/transcribe/upload/stream`, {
      method: "POST",
      headers: { ...transcriptionAuthHeaders(options?.token) },
      body: form,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Transcription cancelled");
    }
    throw error;
  }

  if (response.status === 404) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throw new StreamingUnsupportedError();
  }
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throwBackendError(body, response.status);
  }

  try {
    return await consumeTranscriptionNdjson(response.body as ReadableStream<Uint8Array>, options?.onProgress, options?.onPhase, controller.signal);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Transcription cancelled");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * URL/YouTube transport, streaming: POSTs a JSON body {url, ...request fields}
 * to /transcribe/url/stream (backend fetches via yt-dlp) and consumes the same
 * NDJSON progress protocol, returning the subtitle content.
 */
export async function transcribeUrlWithBackendStreaming(
  backendUrl: string,
  body: Record<string, unknown>,
  options?: TranscribeStreamingOptions,
): Promise<BackendTranscriptionResponse> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");

  const timeoutMs = resolveTranscribeTimeoutMs(options?.timeoutSeconds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`${url}/transcribe/url/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (error instanceof Error && error.name === "AbortError") throw new Error("Transcription cancelled");
    throw error;
  }

  if (response.status === 404) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throw new StreamingUnsupportedError();
  }
  if (!response.ok || !response.body) {
    const errBody = await response.json().catch(() => ({}));
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throwBackendError(errBody, response.status);
  }

  try {
    return await consumeTranscriptionNdjson(response.body as ReadableStream<Uint8Array>, options?.onProgress, options?.onPhase, controller.signal);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Transcription cancelled");
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

// ======== Whisper Model Manager ========
// Thin client over the backend model-manager API. Reuses the same auth-header
// pattern + abortable fetch as the transcription calls. The browser never hits
// the whisper backend directly — these are invoked from the SubSmelt server
// proxy routes (GET /api/whisper/models, POST .../download, DELETE .../:model).

export interface WhisperModelInfo {
  id: string;
  downloaded: boolean;
  sizeMb?: number;
  requiredRamMb?: number;
  requiredVramMb?: number;
  cachePath?: string | null;
}

export interface WhisperModelDownloadProgress {
  pct: number;
  downloadedMb?: number;
  totalMb?: number;
}

export interface WhisperModelDownloadResult {
  ok: boolean;
  model: string;
  cachePath?: string | null;
}

export interface WhisperModelDeleteResult {
  ok: boolean;
  freedMb?: number;
}

// GET {backend}/models → { models: [...] }
export async function listBackendModels(backendUrl: string, token?: string): Promise<WhisperModelInfo[]> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(`${url}/models`, {
    headers: { ...transcriptionAuthHeaders(token) },
  }, SHORT_REQUEST_TIMEOUT_MS, "Whisper model list");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  const models = (body as { models?: unknown })?.models;
  return Array.isArray(models) ? (models as WhisperModelInfo[]) : [];
}

// DELETE {backend}/models/{model} → { ok, freedMb }
export async function deleteBackendModel(backendUrl: string, model: string, token?: string): Promise<WhisperModelDeleteResult> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");
  const response = await fetchWithTimeout(`${url}/models/${encodeURIComponent(model)}`, {
    method: "DELETE",
    headers: { ...transcriptionAuthHeaders(token) },
  }, SHORT_REQUEST_TIMEOUT_MS, "Whisper model delete");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throwBackendError(body, response.status);
  return body as WhisperModelDeleteResult;
}

export interface DownloadBackendModelOptions {
  token?: string;
  timeoutMs?: number;
  onProgress?: (update: WhisperModelDownloadProgress) => void;
}

// Downloads model size can vary; large models take a while, so the download
// stream gets the same generous default as a transcription run.
const DEFAULT_DOWNLOAD_TIMEOUT_MS = DEFAULT_TRANSCRIBE_TIMEOUT_MS;

function toDownloadProgress(record: Record<string, unknown>): WhisperModelDownloadProgress | null {
  const pct = typeof record.pct === "number" ? record.pct : undefined;
  if (pct === undefined) return null;
  return {
    pct,
    ...(typeof record.downloadedMb === "number" ? { downloadedMb: record.downloadedMb } : {}),
    ...(typeof record.totalMb === "number" ? { totalMb: record.totalMb } : {}),
  };
}

// POST {backend}/models/download body {model} → NDJSON stream:
//   {type:"progress",pct,downloadedMb,totalMb} … terminal
//   {type:"result",ok,model,cachePath} or {type:"error",error}
// Consumes the stream line-by-line, invoking onProgress per progress line and
// resolving with the terminal result. Reuses the transcription NDJSON parser.
export async function downloadBackendModel(
  backendUrl: string,
  model: string,
  options?: DownloadBackendModelOptions,
): Promise<WhisperModelDownloadResult> {
  const url = normalizeTranscriptionBackendUrl(backendUrl);
  if (!url) throw new Error("Transcription backend URL is not configured");

  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${url}/models/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...transcriptionAuthHeaders(options?.token) },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Whisper model download timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  }

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    clearTimeout(timer);
    throwBackendError(body, response.status);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: WhisperModelDownloadResult | null = null;
  let streamError: string | null = null;

  const handleLine = (line: string): void => {
    const record = parseNdjsonLine(line);
    if (!record) return;
    const type = record.type;
    if (type === "progress") {
      const update = toDownloadProgress(record);
      if (update && options?.onProgress) options.onProgress(update);
    } else if (type === "result") {
      result = {
        ok: record.ok !== false,
        model: typeof record.model === "string" ? record.model : model,
        ...(typeof record.cachePath === "string" ? { cachePath: record.cachePath } : {}),
      };
    } else if (type === "error") {
      streamError = typeof record.error === "string" ? record.error : "Model download failed";
    }
  };

  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } finally {
    clearTimeout(timer);
  }

  if (streamError) throw new Error(streamError);
  if (!result) throw new Error("Model download stream ended without a result");
  return result;
}

// Reads transcription_request_timeout_s from settings; undefined → default.
export function transcribeTimeoutSeconds(settings: TranscriptionSettings): number | undefined {
  const raw = settings.transcription_request_timeout_s;
  const value = typeof raw === "number" ? raw : Number.parseInt((raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
