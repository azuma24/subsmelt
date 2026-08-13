export const transcribePostActionValues = ["transcribe_only", "transcribe_and_translate"] as const;
export type TranscribePostAction = typeof transcribePostActionValues[number];
export type TranscriptionOutputFormat = "srt" | "vtt" | "txt" | "ass";
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

export interface TranscribeBackendOptions {
  // Total request timeout in seconds. Falls back to the 30-minute default.
  timeoutSeconds?: number;
  // Optional shared-secret token sent as `Authorization: Bearer <token>`.
  token?: string;
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

export interface DownloadBackendModelOptions {
  token?: string;
  timeoutMs?: number;
  onProgress?: (update: WhisperModelDownloadProgress) => void;
}
