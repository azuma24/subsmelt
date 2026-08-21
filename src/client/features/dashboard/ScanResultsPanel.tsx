import { useMemo, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { JobRow, ScannedFile } from "../../types";
import type { ManualTranscriptionProgress, TranscribePostAction } from "./transcription-progress";
import { compareScanFiles, scanFileKey, type DashboardSortBy, type DashboardSortDir } from "./scanSort";
import { useIsMobile } from "../../hooks";
import { buildPathTree, collectFolderPaths, relativeDisplayPath } from "../../components/file-tree/build";
import { FileTreeView, type FileRowContext } from "../../components/file-tree/FileTreeView";
import { usePersistedExpansion } from "../../components/file-tree/use-persisted-expansion";
import { useDrillDown } from "../../components/file-tree/use-drill-down";
import { matchesScanFilter, matchesScanSearch, pathOf, type ScanFilter } from "./scan-file-status";
import { CompactScanFileRow } from "./CompactScanFileRow";
import { ScanFolderRow } from "./ScanFolderRow";

export type { ScanFilter } from "./scan-file-status";

interface ScanResultsPanelProps {
  files: ScannedFile[];
  filter: ScanFilter;
  setFilter: (v: ScanFilter) => void;
  search: string;
  setSearch: (v: string) => void;
  jobsById: Map<number, JobRow>;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
  mode: "preview" | "queued";
  onQueueAll: () => void;
  onTranscribe?: (videoPath: string, postAction: TranscribePostAction) => void;
  onCancelTranscribe?: (videoPath: string) => void;
  selectedVideoPaths?: Set<string>;
  setSelectedVideoPaths?: Dispatch<SetStateAction<Set<string>>>;
  onBatchTranscribe?: (videoPaths: string[], postAction: TranscribePostAction) => void;
  transcriptionEnabled?: boolean;
  transcriptionProgressByPath?: Record<string, ManualTranscriptionProgress>;
  isQueueing: boolean;
  newJobsCount: number;
  mediaDir?: string;
  sortBy: DashboardSortBy;
  sortDir: DashboardSortDir;
  onSortByChange: (value: DashboardSortBy) => void;
  onToggleSortDir: () => void;
}

export function ScanResultsPanel({
  files,
  filter,
  setFilter,
  search,
  setSearch,
  jobsById,
  selectedIds,
  setSelectedIds,
  mode,
  onQueueAll,
  onTranscribe,
  onCancelTranscribe,
  selectedVideoPaths,
  setSelectedVideoPaths,
  onBatchTranscribe,
  transcriptionEnabled = false,
  transcriptionProgressByPath = {},
  isQueueing,
  newJobsCount,
  mediaDir,
  sortBy,
  sortDir,
  onSortByChange,
  onToggleSortDir,
}: ScanResultsPanelProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const selectedPaths = selectedVideoPaths ?? new Set<string>();
  const batchEnabled = transcriptionEnabled && Boolean(onBatchTranscribe && setSelectedVideoPaths);
  const marker = mediaDir ? `${mediaDir.replace(/\/+$/, "")}/` : "/media/";

  // The category chips (all/new/missing/orphans) apply before the tree is
  // built, so an empty folder drops out along with its files. Text search
  // narrows further but switches to a flat list instead of pruning the tree.
  const categoryFiltered = useMemo(
    () => files.filter((file) => matchesScanFilter(file, filter, jobsById)),
    [files, filter, jobsById],
  );
  const searchActive = search.trim().length > 0;
  const searchMatches = useMemo(() => {
    if (!searchActive) return [];
    const query = search.toLowerCase();
    return categoryFiltered
      .filter((file) => matchesScanSearch(file, query))
      .sort((a, b) => compareScanFiles(a, b, sortBy, sortDir));
  }, [categoryFiltered, search, searchActive, sortBy, sortDir]);
  const visibleFiles = searchActive ? searchMatches : categoryFiltered;

  const tree = useMemo(() => buildPathTree(categoryFiltered, {
    pathOf,
    marker,
    compareFiles: (a, b) => compareScanFiles(a, b, sortBy, sortDir),
    compareFolders: (a, b) => a.localeCompare(b) * (sortDir === "asc" ? 1 : -1),
  }), [categoryFiltered, marker, sortBy, sortDir]);

  // Expansion is persisted against the full (category- and search-unfiltered)
  // set of folders, so narrowing a chip or a search query can't silently
  // discard a user's expand/collapse state.
  const fullTree = useMemo(() => buildPathTree(files, {
    pathOf,
    marker,
    compareFiles: (a, b) => compareScanFiles(a, b, sortBy, sortDir),
    compareFolders: (a, b) => a.localeCompare(b) * (sortDir === "asc" ? 1 : -1),
  }), [files, marker, sortBy, sortDir]);
  const folderPaths = useMemo(() => collectFolderPaths(fullTree.children), [fullTree]);
  const expansion = usePersistedExpansion("scan", folderPaths);
  const drill = useDrillDown(tree.children, isMobile && !searchActive);

  // Only act on selections that are still visible under the current filter/search,
  // so the bulk action never transcribes files the user can no longer see.
  const visibleSelectedPaths = useMemo(() => {
    const visible = new Set(visibleFiles.map((f) => f.videoPath).filter(Boolean) as string[]);
    return Array.from(selectedPaths).filter((p) => visible.has(p));
  }, [visibleFiles, selectedPaths]);

  return (
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--text-2)]">{t("dashboard.library")}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${mode === "preview" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "bg-[var(--green-dim)] text-[var(--green)]"}`}>
              {mode === "preview" ? t("app.scanPreviewBadge") : t("app.scanQueuedBadge")}
            </span>
          </div>
          <p className="text-xs text-[var(--text-3)]">{mode === "preview" ? t("app.scanPreviewHint") : t("app.scanGroupedHint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--text-3)]">{t("dashboard.entries", { count: visibleFiles.length })}</span>
          {batchEnabled && visibleSelectedPaths.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onBatchTranscribe?.(visibleSelectedPaths, "transcribe_only")}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-3)]"
              >
                {t("scan.transcription.batchTranscribe", { count: visibleSelectedPaths.length })}
              </button>
              <button
                type="button"
                onClick={() => onBatchTranscribe?.(visibleSelectedPaths, "transcribe_and_translate")}
                className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] hover:brightness-110"
              >
                {t("scan.transcription.batchTranscribeTranslate", { count: visibleSelectedPaths.length })}
              </button>
              <button
                type="button"
                onClick={() => setSelectedVideoPaths?.(new Set())}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)]"
              >
                {t("scan.transcription.clearSelection")}
              </button>
            </div>
          )}
          {mode === "preview" && (
            <button
              type="button"
              onClick={onQueueAll}
              disabled={isQueueing || newJobsCount === 0}
              className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--on-accent)] hover:brightness-110 disabled:opacity-40"
            >
              {isQueueing ? t("dashboard.scanning") : t("dashboard.queuePreview", { count: newJobsCount })}
            </button>
          )}
        </div>
      </div>
      <div className="border-b border-[var(--border)] px-4 py-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          {([
            { key: "all", label: t("app.scanFilterAll") },
            { key: "new", label: t("app.scanFilterNew") },
            { key: "missing", label: t("app.scanFilterMissing") },
            { key: "orphans", label: t("app.scanFilterOrphans") },
          ] as const).map((chip) => (
            <button
              key={chip.key}
              onClick={() => setFilter(chip.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${filter === chip.key ? "bg-[var(--accent-dim)] text-[var(--accent)] border border-[var(--accent-border)]" : "bg-[var(--surface-2)] text-[var(--text-2)]"}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("app.scanSearchPlaceholder")}
          className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-sm text-[var(--text)]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="dashboard-scan-sort" className="text-xs text-[var(--text-3)]">{t("whisper.sortAriaLabel")}</label>
          <select
            id="dashboard-scan-sort"
            value={sortBy}
            onChange={(event) => onSortByChange(event.target.value as DashboardSortBy)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text)]"
          >
            <option value="name">{t("whisper.sortByName")}</option>
            <option value="date">{t("whisper.sortByDate")}</option>
          </select>
          <button
            type="button"
            onClick={onToggleSortDir}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text)]"
            aria-label={sortDir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}
            title={sortDir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}
          >
            {sortDir === "asc" ? "↑" : "↓"}
          </button>
        </div>
      </div>
      <div className="max-h-[50vh] overflow-y-auto">
        {visibleFiles.length === 0 && <div className="px-4 py-6 text-center text-[var(--text-3)] text-sm"><div>{t("app.scanNoMatch")}</div><div className="mt-1 text-xs text-[var(--text-3)]">{t("dashboard.emptyScanHint")}</div></div>}
        {visibleFiles.length > 0 && searchActive && (
          <div>
            {searchMatches.map((file) => (
              <CompactScanFileRow
                key={scanFileKey(file)}
                file={file}
                padLeftPx={16}
                relPath={relativeDisplayPath(pathOf(file), marker)}
                jobsById={jobsById}
                selectedIds={selectedIds}
                setSelectedIds={setSelectedIds}
                onTranscribe={onTranscribe}
                onCancelTranscribe={onCancelTranscribe}
                selectedVideoPaths={selectedPaths}
                setSelectedVideoPaths={setSelectedVideoPaths}
                batchEnabled={batchEnabled}
                transcriptionEnabled={transcriptionEnabled}
                transcriptionProgressByPath={transcriptionProgressByPath}
              />
            ))}
          </div>
        )}
        {visibleFiles.length > 0 && !searchActive && (
          <FileTreeView
            roots={tree.children}
            rootFiles={tree.files}
            isMobile={isMobile}
            expansion={expansion}
            drill={drill}
            homeLabel={t("common.home")}
            fileKey={scanFileKey}
            renderFolderRow={(node, ctx) => (
              <ScanFolderRow
                node={node}
                ctx={ctx}
                batchEnabled={batchEnabled}
                selectedVideoPaths={selectedPaths}
                setSelectedVideoPaths={setSelectedVideoPaths}
              />
            )}
            renderFile={(file, ctx: FileRowContext) => (
              <CompactScanFileRow
                file={file}
                padLeftPx={ctx.padLeftPx}
                jobsById={jobsById}
                selectedIds={selectedIds}
                setSelectedIds={setSelectedIds}
                onTranscribe={onTranscribe}
                onCancelTranscribe={onCancelTranscribe}
                selectedVideoPaths={selectedPaths}
                setSelectedVideoPaths={setSelectedVideoPaths}
                batchEnabled={batchEnabled}
                transcriptionEnabled={transcriptionEnabled}
                transcriptionProgressByPath={transcriptionProgressByPath}
              />
            )}
          />
        )}
      </div>
    </section>
  );
}
