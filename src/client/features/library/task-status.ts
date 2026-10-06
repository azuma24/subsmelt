import type { Job, ManualTranscriptionStage, ScannedFile, TaskStatus } from "../../types";
import type { ManualTranscriptionProgress } from "../dashboard/transcription-progress";
import { STATUS_ICON, STATUS_LABEL_KEY } from "../../app/constants";
import type { IconName } from "../../ui/Icon";

export function getTaskStatus(task: TaskStatus, jobsById: Map<number, Job>): string {
  const liveJob = task.jobId === null ? null : jobsById.get(task.jobId);
  if (liveJob) return liveJob.status;
  if (task.jobId !== null && ["pending", "translating", "error"].includes(task.status)) return "new";
  return task.status;
}

/**
 * How a language's status reads. "skipped" has two causes: the translation is
 * already on disk (a job skipped by the queue, or a file the scan found), or
 * another subtitle of the video owns the output. The first is a finished
 * language and reads "Already translated"; only the second is a real skip.
 */
export function languageStatusDisplay(task: TaskStatus, status: string): { labelKey: string | undefined; icon: IconName | undefined } {
  if (status === "skipped" && (task.jobId !== null || task.outputExists === true))
    return { labelKey: "library.panel.alreadyTranslated", icon: STATUS_ICON.done };
  return { labelKey: STATUS_LABEL_KEY[status], icon: STATUS_ICON[status] };
}

export function stageTone(stage: ManualTranscriptionStage): string {
  switch (stage) {
    case "complete":
      return "text-success";
    case "skipped":
      return "text-warning";
    case "failed":
      return "text-danger";
    case "cancelled":
      return "text-muted";
    case "cancelling":
      return "text-warning";
    default:
      return "text-accent";
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

/** Scan results with `task` shown on the subtitle at `srtPath`, replacing any chip for the same task. */
export function withQueuedTask(files: ScannedFile[], srtPath: string, task: TaskStatus): ScannedFile[] {
  return files.map((file) => {
    if (!file.subtitles.some((sub) => sub.srtPath === srtPath)) return file;
    return {
      ...file,
      subtitles: file.subtitles.map((sub) =>
        sub.srtPath === srtPath
          ? { ...sub, tasks: [...sub.tasks.filter((t) => t.taskId !== task.taskId), task] }
          : sub,
      ),
    };
  });
}
