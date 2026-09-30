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
  /** When the job was claimed (SQLite UTC timestamp); null while pending. */
  started_at?: string | null;
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
  translatedTitle?: string | null;
}

export interface SubtitleEntry {
  srtPath: string;
  srtName: string;
  tasks: TaskStatus[];
}

export interface ScannedFile {
  videoPath: string | null;
  videoName: string | null;
  videoMtime: number | null;
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
  // Per-run overrides (Whisper page). Omit to use global Settings.
  model?: string;
  language?: string;
  device?: string;
  computeType?: string;
  // Per-run speaker diarization toggle (only when caps.advancedOptions.speakerDiarization).
  speakerDiarization?: boolean;
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

// What a speech-to-text model can do, as the backend describes it in
// capabilities.modelInfo. Older backends send only model ids; see
// descriptorsFrom() in features/whisper/whisper-shared.ts.
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

// Model Manager: one row per backend-known model. Backends before 0.6.0 send
// only id, downloaded, sizes and cachePath.
export interface WhisperModel extends Partial<Omit<WhisperModelDescriptor, "id">> {
  id: string;
  downloaded: boolean;
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

// --- YouTube ---

export type YoutubeVideoStatus =
  | "new"
  | "queued"
  | "downloading"
  | "transcribing"
  | "translating"
  | "done"
  | "waiting"
  | "skipped"
  | "unavailable"
  | "failed";

export type YoutubeBackfill =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "posted_since"; date: string }
  | { kind: "added_since"; date: string };

export type YoutubeMedia =
  | { type: "video"; maxHeight: 480 | 720 | 1080 | 1440 | 2160; codec: "h264" | "vp9" | "av1" | "any"; container: "mp4" | "mkv" }
  | { type: "audio"; format: "m4a" | "opus" };

export interface YoutubePlaylistFields {
  folder: string;
  enabled: boolean;
  mode: "auto" | "manual";
  backfill: YoutubeBackfill;
  media: YoutubeMedia;
  captions: "prefer_youtube" | "whisper_only";
  subtitleTaskIds: number[];
  checkEveryMinutes: number;
}

export interface YoutubePlaylist extends YoutubePlaylistFields {
  id: string;
  title: string;
  sync: {
    lastCheckedAt: string | null;
    lastError: string | null;
    count: number | null;
    availability: string | null;
    checking: boolean;
    nextCheckAt: string | null;
  };
  counts: { total: number; removed: number; byStatus: Partial<Record<YoutubeVideoStatus, number>> };
}

export interface YoutubeVideo {
  video_id: string;
  playlist_id: string;
  title: string;
  channel: string | null;
  duration_s: number | null;
  published_at: string | null;
  added_at: string | null;
  status: YoutubeVideoStatus;
  skip_kind: "user" | "before_start" | "members_only" | null;
  reason: string | null;
  attempts: number;
  retry_after: string | null;
  media_path: string | null;
  user_queued_at: string | null;
  position: number | null;
  removed_at: string | null;
  /** Where the transcript came from: "youtube_captions" or "whisper:<model>". */
  transcript_source: string | null;
  /** The spoken language and each picked language's route, once the subtitles are written. */
  subtitles: YoutubeSubtitlePlan | null;
  /** Download or transcription percentage while running, when the server has one. */
  pct?: number;
}

export interface YoutubeSubtitlePlan {
  /** The spoken language's key, such as "en" or "zh-Hant", when known. */
  spoken: string | null;
  routes: { taskId: number; kind: "same" | "captions" | "translate" }[];
}

/** What holds the subtitle and translation steps back. */
export interface YoutubePipeline {
  gpu: { shared: boolean; held: boolean; waitingFor: number; translationRunning: boolean };
  transcription: { ready: boolean; waiting: number };
}

export type YoutubeVideoAction = "download" | "retry" | "skip";

export interface YoutubeCooldown {
  until: string;
  cause: "rate_limited" | "bot_check";
}

export interface YoutubePreviewEntry {
  posted: string | null;
  added: string | null;
  durationS: number | null;
}

export interface YoutubePreview {
  id: string;
  title: string;
  channel: string | null;
  availability: string | null;
  count: number;
  unavailable: number;
  followed: boolean;
  folder: string;
  addedDates: boolean;
  addedDatesError: string | null;
  entries: YoutubePreviewEntry[];
}

export interface YoutubeNotesFolder {
  path: string;
  exists: boolean;
  writable: boolean;
}

export interface YoutubeStatus {
  ytdlp: { available: boolean; version: string | null; path: string | null };
  ffmpeg: { available: boolean; version: string | null };
  apiKey: boolean;
  notes: YoutubeNotesFolder;
  cookies: { present: boolean; updatedAt: string | null };
  cooldown: YoutubeCooldown | null;
}
