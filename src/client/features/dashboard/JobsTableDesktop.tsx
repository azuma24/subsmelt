import { memo, useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDur } from "../../lib";
import { useJobActions, type JobActions } from "../../hooks/useJobActions";
import type { JobRow } from "../../types";
import { MiniBtn, ProgressSmall, RowActionsMenu } from "../../ui/primitives";
import { JobStatusBadge } from "../jobs/JobStatusBadge";
import { jobDerived } from "./job-derived";
import { Icon } from "../../ui/Icon";

interface JobsTableDesktopProps {
  jobs: JobRow[];
  currentJobId: number | null;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
  onPreview: (jobId: number) => void;
  onOpenLogs: (jobId: number) => void;
  onOpenDetails: (job: JobRow) => void;
}

const TH = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.4px] text-[var(--text-3)] border-b border-[var(--border)]";
const TD = "px-3 py-2 align-middle border-b border-[var(--border-sub)]";

// Shared column template so the header row and the virtualized body rows stay
// pixel-aligned. Column order: select | file | target | status | progress |
// time | actions. Every track must be either fixed or fr — the header and each
// row are separate grid containers, so a `max-content` track resolves per row
// and the columns drift out of alignment.
const GRID_COLS =
  "32px minmax(0,1fr) 140px 190px 160px 90px minmax(0,1fr)";
// Estimated row height in px (matches py-2 padding + 13px line content).
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
    onDeleted: useCallback((id: number) => {
      setSelectedIds((s) => {
        if (!s.has(id)) return s;
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }, [setSelectedIds]),
  });

  const pendingIds = jobs.filter((j) => j.status === "pending").map((j) => j.id);
  const visiblePendingSelectedCount = pendingIds.filter((id) => selectedIds.has(id)).length;
  const allPendingSelected = pendingIds.length > 0 && visiblePendingSelectedCount === pendingIds.length;
  const somePendingSelected = visiblePendingSelectedCount > 0 && !allPendingSelected;

  const toggleOne = useCallback((id: number) => {
    setSelectedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, [setSelectedIds]);

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

  const shouldVirtualize = jobs.length > VIRTUALIZE_THRESHOLD;

  return (
    <div className="overflow-x-auto">
      {/* Fixed tracks sum to 612px; 900px keeps the two flexible columns
          (file, actions) usable before horizontal scroll kicks in. */}
      <div className="min-w-[900px] text-sm" role="table">
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
          <div role="row">
            <div role="cell" className="px-4 py-8 text-center text-xs text-[var(--text-3)]">{t("dashboard.noJobsMatchFilter")}</div>
          </div>
        )}

        {jobs.length > 0 && shouldVirtualize ? (
          <VirtualJobRows
            jobs={jobs}
            currentJobId={currentJobId}
            selectedIds={selectedIds}
            onToggle={toggleOne}
            onPreview={onPreview}
            onOpenLogs={onOpenLogs}
            onOpenDetails={onOpenDetails}
            jobActions={jobActions}
          />
        ) : (
          jobs.map((job) => (
            <JobsTableRow
              key={job.id}
              job={job}
              isActive={job.id === currentJobId}
              isSelected={selectedIds.has(job.id)}
              onToggle={toggleOne}
              onPreview={onPreview}
              onOpenLogs={onOpenLogs}
              onOpenDetails={onOpenDetails}
              jobActions={jobActions}
            />
          ))
        )}
      </div>
    </div>
  );
}

const SKELETON_ROWS = 5;

/** Placeholder rows on the real column grid while the first jobs request is in flight. */
export function JobsTableSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto" role="status" aria-busy="true" aria-label={t("errors.loading")}>
      <span className="sr-only">{t("errors.loading")}</span>
      <div className="min-w-[900px] text-sm" aria-hidden="true">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="grid items-center" style={{ gridTemplateColumns: GRID_COLS }}>
            <div className={TD} />
            <div className={TD}><div className="h-4 w-3/4 rounded-sm bg-[var(--surface-3)]" /></div>
            <div className={TD}><div className="h-3 w-24 rounded-sm bg-[var(--surface-2)]" /></div>
            <div className={TD}><div className="h-6 w-20 rounded-full bg-[var(--surface-2)]" /></div>
            <div className={TD}><div className="h-3 w-16 rounded-sm bg-[var(--surface-2)]" /></div>
            <div className={TD}><div className="h-3 w-10 rounded-sm bg-[var(--surface-2)]" /></div>
            <div className={TD}><div className="h-7 w-24 rounded-sm bg-[var(--surface-2)]" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface JobsTableRowProps {
  job: JobRow;
  isActive: boolean;
  isSelected: boolean;
  onToggle: (id: number) => void;
  onPreview: (jobId: number) => void;
  onOpenLogs: (jobId: number) => void;
  onOpenDetails: (job: JobRow) => void;
  jobActions: JobActions;
}

/**
 * One grid row. Memoized so a progress tick re-renders only the translating
 * row: the optimistic jobs patch replaces just that job's object, and every
 * other prop (selection, handlers, actions) holds a stable identity.
 */
const JobsTableRow = memo(function JobsTableRow({
  job,
  isActive,
  isSelected,
  onToggle,
  onPreview,
  onOpenLogs,
  onOpenDetails,
  jobActions,
}: JobsTableRowProps) {
  const { t } = useTranslation();
  const { srtName, pct, hasError, isPending, isSkipped, reason, connectionText, connectionTitle } = jobDerived(job);
  const highlight = isActive || isSelected ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--surface-2)]";
  return (
      <div role="row" className={`grid items-stretch ${highlight}`} style={{ gridTemplateColumns: GRID_COLS }}>
        <div className={`${TD} flex items-center`} role="cell">
          {isPending && (
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              checked={isSelected}
              onChange={() => onToggle(job.id)}
              aria-label={t("dashboard.col.select")}
            />
          )}
        </div>
        <div className={`${TD} min-w-0`} role="cell">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="subtitle" className="text-[var(--text-3)]" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[var(--text)]" title={job.srt_path}>{srtName}</div>
            </div>
          </div>
        </div>
        {/* Fixed-width columns wrap instead of nowrap-overflowing: long target
            names ("Traditional Chinese (Taiwan)") take a second line. One muted
            line — the queue mostly shares a single target, so this column is
            context, not content. */}
        <div className={`${TD} text-xs text-[var(--text-3)]`} role="cell">{job.target_lang} · {job.lang_code}</div>
        <div className={TD} role="cell">
          <div className="flex flex-wrap items-center gap-2">
            <JobStatusBadge job={job} />
            {reason && (
              <span className="rounded-full bg-[var(--red-dim)] px-2 py-1 text-xs text-[var(--red)]">{t(`dashboard.errorReason.${reason}`)}</span>
            )}
          </div>
        </div>
        <div className={`${TD} flex flex-col items-start justify-center gap-1`} role="cell">
          {job.status === "translating" ? (
            <>
              <ProgressSmall pct={pct} />
              {/* Parallel mode runs jobs on different connections; name the machine. */}
              {job.connection && (
                <span className="max-w-[140px] truncate text-xs leading-4 text-[var(--text-3)]" title={connectionTitle ?? undefined}>
                  {connectionText}
                </span>
              )}
            </>
          ) : job.status === "done" ? <span className="text-xs text-[var(--text-3)]">{t("dashboard.cues", { completed: job.completed_cues, total: job.total_cues })}</span> : null}
        </div>
        <div className={`${TD} font-mono text-xs text-[var(--text-2)] whitespace-nowrap`} role="cell">{job.duration_seconds ? formatDur(job.duration_seconds) : ""}</div>
        <div className={TD} role="cell">
          {/* One primary action per status; everything else lives behind the ⋯
              menu. 46 rows of Preview/Re-translate/Details/× was visual noise,
              and the delete glyph wrapped onto its own orphan line. */}
          <div className="flex items-center gap-2">
            {(job.status === "done" || job.status === "translating") && <MiniBtn onClick={() => onPreview(job.id)}>{t("dashboard.action.preview")}</MiniBtn>}
            {/* A translating job can be cancelled on its own: the LLM work is
                aborted and the job ends as a cancelled error, while the queue
                keeps running with the next pending job. */}
            {job.status === "translating" && <MiniBtn color="yellow" onClick={() => jobActions.cancel(job.id)}>{t("dashboard.action.cancel")}</MiniBtn>}
            {job.status === "error" && <MiniBtn color="yellow" onClick={() => jobActions.retry(job.id)}>{t("dashboard.action.retry")}</MiniBtn>}
            {/* A skipped job was never translated, so "Re-translate" is the wrong
                promise — it gets its own wording and a highlighted treatment. */}
            {isSkipped && <MiniBtn color="yellow" onClick={() => jobActions.retranslate(job.id)}>{t("dashboard.action.translateAnyway")}</MiniBtn>}
            {isPending && job.priority > 0 && (
              <MiniBtn onClick={() => jobActions.unpin(job.id)}>{t("dashboard.action.unpin")}</MiniBtn>
            )}
            {isPending && job.priority <= 0 && (
              <MiniBtn onClick={() => jobActions.pin(job.id)}>{t("dashboard.action.pin")}</MiniBtn>
            )}
            <RowActionsMenu
              items={[
                ...(job.status === "done"
                  ? [{ label: t("dashboard.action.retranslate"), onClick: () => jobActions.retranslate(job.id) }]
                  : []),
                ...(job.status === "error"
                  ? [{ label: t("dashboard.action.logs"), onClick: () => onOpenLogs(job.id) }]
                  : []),
                { label: t("dashboard.action.details"), onClick: () => onOpenDetails(job) },
                { label: t("dashboard.action.delete"), onClick: () => { void jobActions.remove(job.id); }, danger: true, disabled: jobActions.isDeleting },
              ]}
            />
          </div>
        </div>
      </div>
    );
  });

interface VirtualJobRowsProps {
  jobs: JobRow[];
  currentJobId: number | null;
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  onPreview: (jobId: number) => void;
  onOpenLogs: (jobId: number) => void;
  onOpenDetails: (job: JobRow) => void;
  jobActions: JobActions;
}

// Windowed body renderer: only the rows currently in (or near) the viewport are
// mounted. Rows are absolutely positioned inside a spacer whose height equals
// the virtualizer's total size, producing the standard top/bottom spacer effect.
function VirtualJobRows({ jobs, currentJobId, selectedIds, onToggle, onPreview, onOpenLogs, onOpenDetails, jobActions }: VirtualJobRowsProps) {
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
              data-index={vitem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vitem.start}px)`,
              }}
            >
              <JobsTableRow
                job={job}
                isActive={job.id === currentJobId}
                isSelected={selectedIds.has(job.id)}
                onToggle={onToggle}
                onPreview={onPreview}
                onOpenLogs={onOpenLogs}
                onOpenDetails={onOpenDetails}
                jobActions={jobActions}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
