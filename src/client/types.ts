export interface Task {
  id: number;
  source_lang: string;
  target_lang: string;
  output_pattern: string;
  lang_code: string;
  enabled: number;
  prompt_override: string;
}

export interface JobRow {
  id: number;
  srt_path: string;
  output_path: string;
  status: string;
  priority: number;
  total_cues: number;
  completed_cues: number;
  error: string | null;
  duration_seconds: number | null;
  target_lang: string;
  lang_code: string;
  force: number;
  analysis_context?: string | null;
  used_connections?: string | null;
  /** Accumulated prompt-token usage for this job (0 when not tracked). */
  input_tokens?: number;
  /** Accumulated completion-token usage for this job (0 when not tracked). */
  output_tokens?: number;
  /** APPROXIMATE estimated USD cost; null for unknown/local models (tokens still tracked). */
  est_cost?: number | null;
}

export interface QueueStatus {
  running: boolean;
  currentJobId: number | null;
  currentJob: JobRow | null;
  pendingCount: number;
  watcherRunning: boolean;
}

export interface TaskStatus {
  taskId: number;
  targetLang: string;
  langCode: string;
  outputName: string;
  status: string;
  jobId: number | null;
}

export interface SubtitleEntry {
  srtPath: string;
  srtName: string;
  tasks: TaskStatus[];
}

export interface ScannedFile {
  videoPath: string | null;
  videoName: string | null;
  subtitles: SubtitleEntry[];
}

export interface ScanResult {
  files: ScannedFile[];
  newJobs: number;
  totalSubtitles: number;
}

export interface FolderNode {
  name: string;
  path: string;
  counts: {
    videos: number;
    subtitles: number;
    pendingJobs: number;
    completeJobs: number;
    errorJobs: number;
  };
  children: FolderNode[];
}

export interface PreviewLine {
  index: number;
  original: string;
  translated: string;
  start?: number;
  end?: number;
}

export interface JobPreview {
  targetLang: string;
  srtPath: string;
  outputPath: string;
  analysis?: string;
  totalLines: number;
  lines: PreviewLine[];
}

export interface LogEntry {
  id: number;
  timestamp: string;
  level: string;
  category: string;
  message: string;
  job_id: number | null;
  meta: string | null;
}

export type LlmProvider = "local" | "openai" | "anthropic" | "gemini";
export type LlmMode = "single" | "fallback" | "parallel";

export interface LlmConnection {
  id: string;
  label: string;
  provider: LlmProvider;
  apiKey: string;
  model: string;
  endpoint: string;
  enabled: boolean;
  order: number;
}

export interface LlmHealth {
  ok: boolean;
  endpointReachable: boolean;
  modelConfigured: boolean;
  modelAvailable: boolean;
  model?: string;
  modelCount?: number;
  status?: number;
  reason?: string;
  message?: string;
}

export type TranscribePostAction = "transcribe_only" | "transcribe_and_translate";
export type ManualTranscriptionStage = "preflighting" | "transcribing" | "queueing" | "complete" | "skipped" | "failed" | "cancelling" | "cancelled";

export interface TranscribeRequest {
  videoPath: string;
  outputFormat?: "srt" | "vtt" | "txt" | "ass";
  postAction?: TranscribePostAction;
}

export interface TranscriptionHistoryEntry {
  id: string;
  inputPath: string;
  outputPath: string;
  model: string;
  language: string;
  outputFormat: "srt" | "vtt" | "txt" | "ass";
  postAction: TranscribePostAction;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  errorSummary: string | null;
  subtitleQuality?: {
    max_line_length?: number;
    max_subtitle_duration?: number;
    merge_short_segments?: boolean;
  } | null;
  advancedOptions?: {
    beam_size?: number;
    patience?: number;
    condition_on_previous_text?: boolean;
    word_timestamps?: boolean;
    initial_prompt?: string;
    speaker_diarization?: boolean;
    bgm_separation?: boolean;
  } | null;
}

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
}

export interface TranscribeResponse {
  ok: boolean;
  attemptId?: string;
  stage?: Extract<ManualTranscriptionStage, "complete">;
  subtitle_path?: string;
  language?: string;
  segments?: number;
  duration_seconds?: number;
  postAction?: TranscribePostAction;
  scanResult?: ScanResult | null;
}

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
    capabilities?: {
      version?: string;
      transportModes?: string[];
      gpus?: { name?: string; total_vram_mb?: number; free_vram_mb?: number }[];
      models?: string[];
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

// Whisper Model Manager — one row per backend-known model.
export interface WhisperModel {
  id: string;
  downloaded: boolean;
  sizeMb?: number;
  requiredRamMb?: number;
  requiredVramMb?: number;
  cachePath?: string | null;
}

export interface WhisperModelDeleteResult {
  ok: boolean;
  freedMb?: number;
}

export interface WhisperModelDownloadResult {
  ok: boolean;
  model: string;
  cachePath?: string | null;
}
