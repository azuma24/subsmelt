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
