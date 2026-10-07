import type {
  ModelEngine,
  ModelSupports,
  TranscribePostAction,
  TranscriptionAdvancedOptions,
  TranscriptionOutputFormat,
  TranscriptionPreflightResponse,
  TranscriptionSubtitleQualityOptions,
  WhisperModelDeleteResult,
  WhisperModelDescriptor,
  WhisperModelDownloadResult,
  WhisperModelInfo,
} from "../../shared/transcription.js";

export { transcribePostActionValues } from "../../shared/transcription.js";
export type {
  ModelEngine,
  ModelSupports,
  TranscribePostAction,
  TranscriptionAdvancedOptions,
  TranscriptionOutputFormat,
  TranscriptionSubtitleQualityOptions,
  WhisperModelDeleteResult,
  WhisperModelDescriptor,
  WhisperModelDownloadResult,
  WhisperModelInfo,
};
export type LowRamBehavior = "ask" | "downgrade" | "skip" | "run_anyway";

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
  preferred_chinese?: string;
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
  // A history retry replays the advanced options its attempt ran with, in
  // place of the per-folder / global ones.
  advanced_options?: TranscriptionAdvancedOptions;
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
  // The backend converts a Chinese transcript to this script (OpenCC).
  chinese_script?: "zh-TW" | "zh-CN";
}

/** What the backend's /preflight answers; the client sees it as TranscriptionPreflightResponse. */
export type BackendPreflightResponse = TranscriptionPreflightResponse;

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

export interface TranscribeBackendOptions {
  // Timeout in seconds (default 30 minutes): a total for the JSON endpoints, an
  // idle timeout reset by every line for the streamed ones.
  timeoutSeconds?: number;
  // Optional shared-secret token sent as `Authorization: Bearer <token>`.
  token?: string;
  // Aborting this signal cancels the HTTP request.
  signal?: AbortSignal;
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
}

export interface BackendCapabilities {
  models?: string[];
  modelInfo?: WhisperModelDescriptor[];
  nemoSpeech?: { available: boolean; version: string | null };
  [key: string]: unknown;
}

export interface BackendHealthResponse {
  capabilities?: BackendCapabilities;
  [key: string]: unknown;
}

export interface WhisperModelDownloadProgress {
  pct: number;
  downloadedMb?: number;
  totalMb?: number;
}

export interface DownloadBackendModelOptions {
  token?: string;
  timeoutMs?: number;
  onProgress?: (update: WhisperModelDownloadProgress) => void;
}
