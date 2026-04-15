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

export interface TranscriptionJob {
  id: number;
  kind: string;                 // 'transcribe' | 'download'
  video_path: string | null;
  output_path: string | null;
  output_format: string | null;
  model_kind: string | null;
  model_name: string | null;
  status: string;               // pending|running|done|error|cancelled
  stage: string | null;
  progress: number;
  error: string | null;
  whisper_task_id: string | null;
  options_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhisperHealth {
  ok: boolean;
  auth_required: boolean;
  device: string;
  compute_type: string;
  max_concurrent: number;
  media_dir: string;
  models_dir: string;
  gpu_name: string | null;
  cuda_available: boolean;
  vram_free_bytes: number | null;
}

export interface WhisperModelEntry {
  name: string;
  path?: string;
  size_bytes?: number;
  repo_id?: string;
  size_hint?: string;
  description?: string;
}

export interface WhisperModelsResponse {
  whisper: { cached: WhisperModelEntry[]; catalog: WhisperModelEntry[] };
  uvr: { cached: WhisperModelEntry[]; catalog: WhisperModelEntry[] };
}
