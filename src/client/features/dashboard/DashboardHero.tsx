import type { TFunction } from "i18next";
import type { JobRow } from "../../types";
import { StatusStrip, StatCard } from "../../ui/primitives";
import { ActiveJobCard } from "./ActiveJobCard";

interface StatusSegment {
  key: string;
  label: string;
  count: number;
  color: string;
  activeColor: string;
}

interface DashboardHeroProps {
  statusSegments: StatusSegment[];
  statusFilter: string;
  activeJobs: JobRow[];
  pendingJobs: JobRow[];
  doneJobs: JobRow[];
  errorJobs: JobRow[];
  onSelectStatus: (key: string) => void;
  t: TFunction;
}

export function DashboardHero({
  statusSegments,
  statusFilter,
  activeJobs,
  pendingJobs,
  doneJobs,
  errorJobs,
  onSelectStatus,
  t,
}: DashboardHeroProps) {
  return (
    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:gap-4">
      {/* Left: Status strip + active job */}
      <div className="min-w-0 flex-1 space-y-3">
        {/* StatusStrip — condensed stat row, each segment clickable to filter */}
        <StatusStrip
          segments={statusSegments}
          activeKey={statusFilter}
          onSelect={onSelectStatus}
        />
        {activeJobs.length > 0 && (
          <div className="flex flex-col gap-2">
            {activeJobs.map((j, i) => (
              <ActiveJobCard key={j.id} job={j} pendingCount={i === 0 ? pendingJobs.length : 0} />
            ))}
          </div>
        )}
      </div>
      {/* Right: quick-stat cards (kept for xl layout, condensed) — xl:w-[34rem] */}
      <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-2 xl:grid-cols-4 xl:w-[34rem]">
        <StatCard label={t("dashboard.stat.pending")} value={pendingJobs.length} color="text-[var(--yellow)]" onClick={() => onSelectStatus("pending")} />
        <StatCard label={t("dashboard.stat.translating")} value={activeJobs.length} color="text-[var(--accent)]" onClick={() => onSelectStatus("translating")} />
        <StatCard label={t("dashboard.stat.done")} value={doneJobs.length} color="text-[var(--green)]" onClick={() => onSelectStatus("done")} />
        <StatCard
          label={t("dashboard.stat.errors")}
          value={errorJobs.length}
          color="text-[var(--red)]"
          onClick={() => onSelectStatus("error")}
        />
      </div>
    </div>
  );
}
