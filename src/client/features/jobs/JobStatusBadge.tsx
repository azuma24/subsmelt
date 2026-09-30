import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { STATUS_ICON, STATUS_LABEL_KEY } from "../../app/constants";
import type { JobRow } from "../../types";
import { StatusBadge, type StatusDescriptor, type StatusTone } from "../../ui/primitives";

// `skipped` gets its own tone: it means the file was never translated, so it
// must not look as inert as a merely queued `pending` job.
const JOB_TONE: Record<string, StatusTone> = {
  done: "ok",
  translating: "run",
  error: "bad",
  skipped: "warn",
};

export function jobStatusDescriptor(job: Pick<JobRow, "status" | "force" | "priority">, t: TFunction): StatusDescriptor {
  const label = STATUS_LABEL_KEY[job.status] ? t(STATUS_LABEL_KEY[job.status]) : job.status;
  return {
    glyph: STATUS_ICON[job.status] ?? "",
    label: `${label}${job.force ? " ⚡" : ""}${job.priority > 0 ? " 📌" : ""}`,
    tone: JOB_TONE[job.status] ?? "neutral",
  };
}

export function JobStatusBadge({ job, compact = false }: { job: JobRow; compact?: boolean }) {
  const { t } = useTranslation();
  return <StatusBadge status={jobStatusDescriptor(job, t)} compact={compact} />;
}
