import type { ScanResult } from "./scan.js";

export const transcribePostActionValues = ["transcribe_only", "transcribe_and_translate"] as const;
export type TranscribePostAction = (typeof transcribePostActionValues)[number];
export type TranscriptionOutputFormat = "srt" | "vtt" | "txt" | "ass";

export interface TranscriptionSubtitleQualityOptions {
  max_line_length?: number;
  max_subtitle_duration?: number;
  merge_short_segments?: boolean;
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

export type TranscriptionAttemptStatus = "running" | "succeeded" | "failed" | "cancelled";

/** One run in transcription-history.json and GET /api/transcription/history. */
export interface TranscriptionHistoryEntry {
  id: string;
  inputPath: string;
  outputPath: string;
  model: string;
  language: string;
  outputFormat: TranscriptionOutputFormat;
  postAction: TranscribePostAction;
  status: TranscriptionAttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  errorSummary: string | null;
  subtitleQuality?: TranscriptionSubtitleQualityOptions | null;
  advancedOptions?: TranscriptionAdvancedOptions | null;
  // Absent on attempts recorded before retries replayed them.
  device?: string;
  computeType?: string;
  overwrite?: boolean;
}

export type ModelEngine = "whisper" | "nemotron";

export interface ModelSupports {
  prompt: boolean;
  beamSize: boolean;
  conditionOnPreviousText: boolean;
  vad: boolean;
  computeType: boolean;
  wordTimestamps: boolean;
  translateTask: boolean;
}

/** What a speech-to-text model can do, as the backend describes it in capabilities.modelInfo and on GET /models. */
export interface WhisperModelDescriptor {
  id: string;
  engine: ModelEngine;
  label: string;
  sizeMb?: number;
  requiredRamMb?: number;
  requiredVramMb?: number;
  languages: "all" | string[];
  supports: ModelSupports;
  available: boolean;
  unavailableReason: string | null;
}

/** Model Manager: one row per backend-known model. Backends before 0.6.0 send only id, downloaded, sizes and cachePath. */
export interface WhisperModelInfo extends Partial<Omit<WhisperModelDescriptor, "id">> {
  id: string;
  downloaded: boolean;
  cachePath?: string | null;
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

/** Body of POST /api/transcription/transcribe and /preflight. */
export interface TranscribeRequest {
  videoPath: string;
  outputFormat?: TranscriptionOutputFormat;
  postAction?: TranscribePostAction;
  // Per-run overrides (Whisper page). Omit to use global Settings.
  model?: string;
  language?: string;
  device?: string;
  computeType?: string;
  // Per-run speaker diarization toggle (only when caps.advancedOptions.speakerDiarization).
  speakerDiarization?: boolean;
  // The user confirmed replacing this video's existing subtitles: the new
  // transcript takes the standard name (Movie.eng.srt) even if a file is there.
  overwrite?: boolean;
}

/** What the backend's preflight reports, passed through by POST /api/transcription/preflight. */
export interface TranscriptionPreflightResponse {
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

export interface TranscribeResponse {
  ok: boolean;
  attemptId?: string;
  stage?: "complete";
  subtitle_path?: string;
  language?: string;
  segments?: number;
  duration_seconds?: number;
  postAction?: TranscribePostAction;
  scanResult?: ScanResult | null;
}

/** GET /api/transcription/health. */
export interface TranscriptionHealth {
  ok: boolean;
  endpointReachable: boolean;
  backendUrl?: string;
  reason?: string;
  message?: string;
  health?: {
    ffmpeg?: boolean;
    totalRamMb?: number;
    availableRamMb?: number;
    modelCache?: TranscriptionPreflightResponse["modelCache"];
    capabilities?: {
      version?: string;
      transportModes?: string[];
      gpus?: { name?: string; total_vram_mb?: number; free_vram_mb?: number }[];
      models?: string[];
      modelInfo?: WhisperModelDescriptor[];
      nemoSpeech?: { available: boolean; version: string | null };
      devices?: string[];
      computeTypes?: string[];
      outputFormats?: string[];
      vad?: boolean;
      advancedOptions?: {
        beamSize?: boolean;
        patience?: boolean;
        conditionOnPreviousText?: boolean;
        wordTimestamps?: boolean;
        initialPrompt?: boolean;
        speakerDiarization?: boolean;
        bgmSeparation?: boolean;
      };
    };
  };
}
