import type { JobRow, ManualTranscriptionStage, ScannedFile, TaskStatus } from "../../types";
import type { ManualTranscriptionProgress } from "./transcription-progress";

export type ScanFilter = "all" | "new" | "missing" | "orphans";

export function pathOf(file: ScannedFile): string {
  return file.videoPath || file.subtitles[0]?.srtPath || "";
}

export function matchesScanFilter(file: ScannedFile, filter: ScanFilter, jobsById: Map<number, JobRow>): boolean {
  if (filter === "orphans") return !file.videoName;
  if (filter === "missing") return !!file.videoName && file.subtitles.length === 0;
  if (filter === "new") return file.subtitles.some((sub) => sub.tasks.some((task) => {
    const status = getTaskStatus(task, jobsById);
    return status === "new" || status === "pending";
  }));
  return true;
}

export function matchesScanSearch(file: ScannedFile, query: string): boolean {
  if (!query) return true;
  return `${file.videoName || ""} ${file.subtitles.map((s) => s.srtName).join(" ")}`.toLowerCase().includes(query);
}

export function getTaskStatus(task: TaskStatus, jobsById: Map<number, JobRow>): string {
  const liveJob = task.jobId === null ? null : jobsById.get(task.jobId);
  if (liveJob) return liveJob.status;
  if (task.jobId !== null && ["pending", "translating", "error"].includes(task.status)) return "new";
  return task.status;
}

export function getPendingJobIds(file: ScannedFile, jobsById: Map<number, JobRow>): number[] {
  return file.subtitles.flatMap((sub) =>
    sub.tasks
      .filter((task) => task.jobId !== null && jobsById.get(task.jobId)?.status === "pending")
      .map((task) => task.jobId as number)
  );
}

export function stageTone(stage: ManualTranscriptionStage): string {
  switch (stage) {
    case "complete":
      return "text-[var(--green)]";
    case "skipped":
      return "text-[var(--yellow)]";
    case "failed":
      return "text-[var(--red)]";
    case "cancelled":
      return "text-[var(--text-2)]";
    case "cancelling":
      return "text-[var(--yellow)]";
    default:
      return "text-[var(--accent)]";
  }
}

export function stageText(
  progress: ManualTranscriptionProgress,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (progress.stage) {
    case "preflighting":
      return t("scan.transcription.preflighting");
    case "transcribing":
      return typeof progress.pct === "number"
        ? t("scan.transcription.progressPct", { pct: Math.round(progress.pct) })
        : t("scan.transcription.transcribing");
    case "queueing":
      return t("scan.transcription.queueing");
    case "complete":
      return progress.postAction === "transcribe_and_translate"
        ? t("scan.transcription.completeQueued")
        : t("scan.transcription.completeSubtitle");
    case "skipped":
      return progress.message || t("scan.transcription.skipped");
    case "failed":
      return progress.message || t("scan.transcription.failed");
    case "cancelling":
      return t("scan.transcription.cancelling");
    case "cancelled":
      return t("scan.transcription.cancelled");
  }
}
