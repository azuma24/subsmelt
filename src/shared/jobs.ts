export type JobStatus = "pending" | "translating" | "done" | "error" | "skipped";

/** A `jobs` row as stored in SQLite. */
export interface JobRow {
  id: number;
  task_id: number;
  srt_path: string;
  output_path: string;
  video_path: string | null;
  status: string;
  priority: number;
  force: number;
  total_cues: number;
  completed_cues: number;
  error: string | null;
  analysis_context: string | null;
  used_connections: string | null;
  duration_seconds: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** When the job was claimed (SQLite UTC timestamp); null while pending. */
  started_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** The LLM connection ("machine") a translating job runs on. */
export interface JobConnection {
  id: string;
  label: string;
  host: string;
  model: string;
}

/**
 * A job as GET /api/jobs and /api/queue/status return it: the row with its
 * task's languages, normalised token counts, an approximate cost and the live
 * connection. The list leaves out analysis_context, which can be large.
 */
export interface Job extends Omit<JobRow, "analysis_context" | "input_tokens" | "output_tokens"> {
  analysis_context?: string | null;
  input_tokens: number;
  output_tokens: number;
  /** APPROXIMATE estimated USD cost; null for unknown or local models (tokens are still tracked). */
  est_cost: number | null;
  target_lang: string;
  lang_code: string;
  source_lang: string;
  connection: JobConnection | null;
}

export interface JobsResponse {
  jobs: Job[];
  queueRunning: boolean;
  currentJobId: number | null;
}

export interface QueueStatus {
  running: boolean;
  currentJobId: number | null;
  currentJob: Job | null;
  /** Parallel mode: every translating job with the connection running it. */
  activeConnections: ({ jobId: number } & JobConnection)[];
  pendingCount: number;
  watcherRunning: boolean;
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

/** A `logs` row as stored in SQLite and returned by GET /api/logs. */
export interface LogRow {
  id: number;
  timestamp: string;
  level: string;
  category: string;
  message: string;
  job_id: number | null;
  meta: string | null;
}
