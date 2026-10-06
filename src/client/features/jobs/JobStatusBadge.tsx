import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { STATUS_ICON, STATUS_LABEL_KEY } from "../../app/constants";
import type { JobRow } from "../../types";
import { StatusBadge, type StatusDescriptor, type StatusFlag, type StatusTone } from "../../ui/primitives";

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
  const icon = STATUS_ICON[job.status];
  const flags: StatusFlag[] = [];
  if (job.force) flags.push({ icon: "forced", label: t("app.forceEnabled") });
  if (job.priority > 0) flags.push({ icon: "pinned", label: t("app.pinned") });
  return {
    glyph: icon ? { icon } : "",
    label,
    tone: JOB_TONE[job.status] ?? "neutral",
    flags,
  };
}

export function JobStatusBadge({ job }: { job: JobRow }) {
  const { t } = useTranslation();
  return <StatusBadge status={jobStatusDescriptor(job, t)} />;
}
