import type { JobRow } from "../../types";
import { classifyErrorReason } from "./job-actions";

export interface JobDerived {
  /** The subtitle's file name, as shown in the row or card. */
  srtName: string;
  /** 0-100 progress for a translating job; 0 otherwise. */
  pct: number;
  hasError: boolean;
  isPending: boolean;
  isSkipped: boolean;
  /** The classified error-reason slug, or null when there is no error. */
  reason: string | null;
  /** "label · model" of the connection translating the job, or null. */
  connectionText: string | null;
  /** "label — model — host", the untruncated tooltip for connectionText. */
  connectionTitle: string | null;
}

/** Row/card display state derived from a job. Shared by the desktop table and
 *  the mobile card so the two surfaces cannot drift apart — a new status means
 *  editing this one function, not both renderers. */
export function jobDerived(job: JobRow): JobDerived {
  const hasError = job.status === "error" && Boolean(job.error);
  const connection = job.connection;
  return {
    srtName: job.srt_path.split("/").pop() || "",
    pct: job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0,
    hasError,
    isPending: job.status === "pending",
    isSkipped: job.status === "skipped",
    reason: hasError ? classifyErrorReason(job.error) : null,
    connectionText: connection ? [connection.label, connection.model].filter(Boolean).join(" · ") : null,
    connectionTitle: connection
      ? [connection.label, connection.model, connection.host].filter(Boolean).join(" — ")
      : null,
  };
}
