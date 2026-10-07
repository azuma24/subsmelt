export type ScanTaskState = "done" | "pending" | "translating" | "error" | "skipped" | "new";

/** One task's standing for one source subtitle. */
export interface ScannedTask {
  taskId: number;
  targetLang: string;
  langCode: string;
  outputPath: string;
  outputName: string;
  status: ScanTaskState;
  jobId: number | null;
  translatedTitle: string | null;
  /** The translation is on disk, in any spelling: a "skipped" without it means another subtitle owns the output. */
  outputExists: boolean;
}

export interface ScannedSubtitle {
  srtPath: string;
  srtName: string;
  tasks: ScannedTask[];
}

export interface ScannedFile {
  videoPath: string | null;
  videoName: string | null;
  videoMtime: number | null;
  subtitles: ScannedSubtitle[];
}

export interface ScanResult {
  files: ScannedFile[];
  newJobs: number;
  totalSubtitles: number;
}

export interface FolderCounts {
  videos: number;
  subtitles: number;
  pendingJobs: number;
  completeJobs: number;
  errorJobs: number;
}

export interface FolderNode {
  name: string;
  path: string;
  counts: FolderCounts;
  children: FolderNode[];
}
