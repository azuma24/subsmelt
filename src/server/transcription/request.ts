import path from "node:path";

import type {
  BackendTranscriptionRequest,
  BuildTranscriptionRequestOptions,
  TranscriptionAdvancedOptions,
  TranscriptionFolderDefaults,
  TranscriptionOutputFormat,
  TranscriptionSettings,
  TranscriptionSubtitleQualityOptions,
  TranscriptionTransportMode,
} from "./types.js";
import { transcribePostActionValues } from "./types.js";

/**
 * Resolves which file transport to use (plan Phase 2).
 *
 * - "shared"/"upload" in settings force that mode.
 * - An explicit path mapping signals shared-FS intent → shared.
 * - "auto" (default): inspect the backend URL host. A loopback/local host shares
 *   the filesystem with the SubSmelt server (local same-host / Docker volume) →
 *   shared. A remote host cannot see local paths → upload. If the URL can't be
 *   parsed, fall back to the token-based heuristic (token ⇒ remote ⇒ upload).
 */
export function resolveTransportMode(settings: TranscriptionSettings): TranscriptionTransportMode {
  const explicit = (settings.transcription_transport || "").trim().toLowerCase();
  if (explicit === "shared" || explicit === "upload") return explicit;

  const hasMapping = Boolean(
    settings.transcription_path_map_from?.trim() && settings.transcription_path_map_to?.trim(),
  );
  if (hasMapping) return "shared";

  const backendUrl = (settings.transcription_backend_url || "").trim();
  try {
    // Loopback hosts share the local filesystem; only truly remote hosts need an
    // upload because they cannot read paths visible to the SubSmelt server.
    const host = new URL(backendUrl).hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
    return loopback ? "shared" : "upload";
  } catch {
    // URL missing/unparseable: keep the prior token-based heuristic as a safety net.
    const hasToken = Boolean(settings.transcription_backend_token?.trim());
    return hasToken ? "upload" : "shared";
  }
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

// Reads transcription_request_timeout_s from settings; undefined → default.
export function transcribeTimeoutSeconds(settings: TranscriptionSettings): number | undefined {
  const raw = settings.transcription_request_timeout_s;
  const value = typeof raw === "number" ? raw : Number.parseInt((raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
