import { useRef, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDur } from "../../lib";
import { useJobActions } from "../../hooks/useJobActions";
import type { JobRow } from "../../types";
import { MiniBtn, ProgressSmall, StatusBadge } from "../../ui/primitives";

interface JobsTableDesktopProps {
  jobs: JobRow[];
  currentJobId: number | null;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
  onPreview: (jobId: number) => void;
  onOpenLogs: (jobId: number) => void;
  onOpenDetails: (job: JobRow) => void;
}

const TH = "px-[10px] py-[7px] text-left text-[10.5px] font-semibold uppercase tracking-[0.4px] text-[var(--text-3)] border-b border-[var(--border)]";
const TD = "px-[10px] py-[9px] align-middle border-b border-[var(--border-sub)]";

// Shared column template so the header row and the virtualized body rows stay
// pixel-aligned. Mirrors the original <th>/<td> column order:
// select | file | target | status | progress | time | actions
const GRID_COLS =
  "32px minmax(0,1fr) max-content max-content 160px max-content minmax(0,1fr)";
// Estimated row height in px (matches py-[9px] padding + 13px line content).
// react-virtual measures actual heights, so this is only an initial estimate.
const ROW_ESTIMATE = 46;
// Above this many rows we window the list; below it we render everything so
// small queues keep simple, fully-rendered behavior.
const VIRTUALIZE_THRESHOLD = 200;
// Cap the scroll viewport so the windowed list has a bounded height to scroll in.
const MAX_VIEWPORT_PX = 640;

export function JobsTableDesktop({
  jobs,
  currentJobId,
  selectedIds,
  setSelectedIds,
  onPreview,
  onOpenLogs,
  onOpenDetails,
}: JobsTableDesktopProps) {
  const { t } = useTranslation();
  const jobActions = useJobActions({
    onDeleted: (id) =>
      setSelectedIds((s) => {
        if (!s.has(id)) return s;
        const n = new Set(s);
        n.delete(id);
        return n;
      }),
  });
  const { classifyErrorReason } = jobActions;

  const pendingIds = jobs.filter((j) => j.status === "pending").map((j) => j.id);
  const visiblePendingSelectedCount = pendingIds.filter((id) => selectedIds.has(id)).length;
  const allPendingSelected = pendingIds.length > 0 && visiblePendingSelectedCount === pendingIds.length;
  const somePendingSelected = visiblePendingSelectedCount > 0 && !allPendingSelected;

  const toggleOne = (id: number) => {
    setSelectedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((s) => {
      const n = new Set(s);
      if (allPendingSelected) {
        pendingIds.forEach((id) => n.delete(id));
      } else {
        pendingIds.forEach((id) => n.add(id));
      }
      return n;
    });
  };

  // Renders the cell contents for a single job row. Used both by the
  // virtualized and non-virtualized code paths so behavior/markup stay identical.
  const renderRowCells = (job: JobRow) => {
    const srtName = job.srt_path.split("/").pop() || "";
    const pct = job.total_cues > 0 ? Math.round((job.completed_cues / job.total_cues) * 100) : 0;
    const hasError = job.status === "error" && job.error;
    const isPending = job.status === "pending";
    const isSelected = selectedIds.has(job.id);
    const reason = hasError ? classifyErrorReason(job.error) : null;
    return (
      <>
        <div className={`${TD} flex items-center`}>
          {isPending && (
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              checked={isSelected}
              onChange={() => toggleOne(job.id)}
              aria-label={t("dashboard.col.select")}
            />
          )}
        </div>
        <div className={`${TD} min-w-0`}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[13px] opacity-50">📄</span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-[var(--text)]" title={job.srt_path}>{srtName}</div>
            </div>
          </div>
        </div>
        <div className={`${TD} text-[12px] text-[var(--text-2)] whitespace-nowrap`}>{job.target_lang}<br /><span className="text-[var(--text-3)]">{job.lang_code}</span></div>
        <div className={`${TD} whitespace-nowrap`}>
          <StatusBadge job={job} />
          {reason && (
            <span className="ml-2 rounded-full bg-[var(--red-dim)] px-2 py-0.5 text-[10px] text-[var(--red)]">{t(`dashboard.errorReason.${reason}`)}</span>
          )}
        </div>
        <div className={`${TD} flex items-center`}>{job.status === "translating" ? <ProgressSmall pct={pct} /> : job.status === "done" ? <span className="text-[10px] text-[var(--text-3)]">{t("dashboard.cues", { completed: job.completed_cues, total: job.total_cues })}</span> : null}</div>
        <div className={`${TD} font-mono text-[11.5px] text-[var(--text-2)] whitespace-nowrap`}>{job.duration_seconds ? formatDur(job.duration_seconds) : ""}</div>
        <div className={TD}>
          <div className="flex flex-wrap gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            {isPending && job.priority > 0 && (
              <MiniBtn onClick={() => jobActions.unpin(job.id)}>{t("dashboard.action.unpin")}</MiniBtn>
            )}
            {isPending && job.priority <= 0 && (
              <MiniBtn onClick={() => jobActions.pin(job.id)}>{t("dashboard.action.pin")}</MiniBtn>
            )}
            {(job.status === "done" || job.status === "translating") && <MiniBtn onClick={() => onPreview(job.id)}>{t("dashboard.action.preview")}</MiniBtn>}
            {job.status === "error" && <MiniBtn color="yellow" onClick={() => jobActions.retry(job.id)}>{t("dashboard.action.retry")}</MiniBtn>}
            {(job.status === "done" || job.status === "skipped") && <MiniBtn onClick={() => jobActions.retranslate(job.id)}>{t("dashboard.action.retranslate")}</MiniBtn>}
            {job.status === "error" && <MiniBtn onClick={() => onOpenLogs(job.id)}>{t("dashboard.action.logs")}</MiniBtn>}
            <button
              onClick={() => onOpenDetails(job)}
              className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--text-2)] hover:text-[var(--text)]"
            >{t("dashboard.action.details")}</button>
            <button
              onClick={() => { void jobActions.remove(job.id); }}
              disabled={jobActions.isDeleting}
              className="rounded-md px-1.5 text-[var(--text-3)] hover:text-[var(--red)] disabled:opacity-40"
              aria-label={t("dashboard.action.delete")}
            >×</button>
          </div>
        </div>
      </>
    );
  };

  const rowClassName = (job: JobRow) => {
    const isActive = job.id === currentJobId;
    const isSelected = selectedIds.has(job.id);
    return `group grid items-stretch ${isActive ? "bg-[var(--accent-dim)]" : isSelected ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--surface-2)]"}`;
  };

  const shouldVirtualize = jobs.length > VIRTUALIZE_THRESHOLD;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[820px] text-[13px]" role="table">
        {/* Header row — shares the grid template with body rows for column alignment. */}
        <div role="row" className="grid" style={{ gridTemplateColumns: GRID_COLS }}>
          <div className={TH} role="columnheader">
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              disabled={pendingIds.length === 0}
              checked={allPendingSelected}
              ref={(el) => {
                if (el) el.indeterminate = somePendingSelected;
              }}
              onChange={toggleAllVisible}
              aria-label={t("dashboard.col.selectAll")}
            />
          </div>
          <div className={TH} role="columnheader">{t("dashboard.col.file")}</div>
          <div className={TH} role="columnheader">{t("dashboard.col.target")}</div>
          <div className={TH} role="columnheader">{t("dashboard.col.status")}</div>
          <div className={TH} role="columnheader">{t("dashboard.col.progress")}</div>
          <div className={TH} role="columnheader">{t("dashboard.col.time")}</div>
          <div className={TH} role="columnheader">{t("dashboard.col.actions")}</div>
        </div>

        {jobs.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--text-3)]" role="row">{t("dashboard.noJobsMatchFilter")}</div>
        )}

        {jobs.length > 0 && shouldVirtualize ? (
          <VirtualJobRows
            jobs={jobs}
            renderRowCells={renderRowCells}
            rowClassName={rowClassName}
          />
        ) : (
          jobs.map((job) => (
            <div
              key={job.id}
              role="row"
              className={rowClassName(job)}
              style={{ gridTemplateColumns: GRID_COLS }}
            >
              {renderRowCells(job)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface VirtualJobRowsProps {
  jobs: JobRow[];
  renderRowCells: (job: JobRow) => ReactNode;
  rowClassName: (job: JobRow) => string;
}

// Windowed body renderer: only the rows currently in (or near) the viewport are
// mounted. Rows are absolutely positioned inside a spacer whose height equals
// the virtualizer's total size, producing the standard top/bottom spacer effect.
function VirtualJobRows({ jobs, renderRowCells, rowClassName }: VirtualJobRowsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 12,
  });

  return (
    <div
      ref={scrollRef}
      // `scrollbarGutter: stable` reserves the scrollbar track so the windowed
      // rows keep a constant content width and stay aligned with the header
      // columns whether or not a classic (non-overlay) scrollbar is present.
      style={{ maxHeight: MAX_VIEWPORT_PX, overflowY: "auto", scrollbarGutter: "stable" }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((vitem) => {
          const job = jobs[vitem.index];
          return (
            <div
              key={job.id}
              role="row"
              data-index={vitem.index}
              ref={virtualizer.measureElement}
              className={rowClassName(job)}
              style={{
                gridTemplateColumns: GRID_COLS,
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vitem.start}px)`,
              }}
            >
              {renderRowCells(job)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
