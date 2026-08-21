import { useTranslation } from "react-i18next";
import type { ScannedFile } from "../../types";
import { ActionButton, EmptyHint, SelectionBar, SettingsSection } from "../../ui/primitives";
import { relativeDisplayPath } from "../../components/file-tree/build";
import { FileTreeView, type FileRowContext, type FolderRowContext } from "../../components/file-tree/FileTreeView";
import type { TreeExpansion } from "../../components/file-tree/use-persisted-expansion";
import type { DrillDownState } from "../../components/file-tree/use-drill-down";
import type { SortBy, SortDir, TreeNode } from "./folderTree";
import { baseName, type FileProgress, selectCls } from "./whisper-shared";

export interface LibraryPickerProps {
  isMobile: boolean;
  libraryQuery: string;
  onLibraryQueryChange: (value: string) => void;
  hideWithSubtitles: boolean;
  onHideWithSubtitlesChange: (checked: boolean) => void;
  sortBy: SortBy;
  onSortByChange: (value: SortBy) => void;
  sortDir: SortDir;
  onToggleSortDir: () => void;
  onSelectAll: () => void;
  running: boolean;
  visibleFiles: ScannedFile[];
  videoFiles: ScannedFile[];
  isFiltered: boolean;
  isScanFetching: boolean;
  isScanLoading: boolean;
  onRefreshScan: () => unknown;
  selectedVisibleCount: number;
  onClearSelection: () => void;
  onTranscribeSelected: () => Promise<void>;
  downloadsActive: boolean;
  progress: { done: number; total: number } | null;
  onCancelBatch: () => Promise<void>;
  filterActive: boolean;
  tree: TreeNode;
  selected: Set<string>;
  toggleFile: (vp: string) => void;
  toggleFolder: (paths: string[]) => void;
  fileProgress: Record<string, FileProgress>;
  activePath: string | null;
  expansion: TreeExpansion;
  drill: DrillDownState<TreeNode>;
}

/**
 * The "Library" settings section — the primary working surface. Filter/search
 * bar, selection bar with transcribe/cancel actions, a flat filtered list when
 * a text filter is active, and the folder-tree view otherwise.
 */
export function LibraryPicker({
  isMobile, libraryQuery, onLibraryQueryChange, hideWithSubtitles, onHideWithSubtitlesChange,
  sortBy, onSortByChange, sortDir, onToggleSortDir, onSelectAll, running, visibleFiles, videoFiles,
  isFiltered, isScanFetching, isScanLoading, onRefreshScan, selectedVisibleCount, onClearSelection,
  onTranscribeSelected, downloadsActive, progress, onCancelBatch, filterActive, tree, selected,
  toggleFile, toggleFolder, fileProgress, activePath, expansion, drill,
}: LibraryPickerProps) {
  const { t } = useTranslation();

  return (
    <SettingsSection title={t("whisper.pickerTitle")} description={t("whisper.pickerHint")}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={libraryQuery}
          onChange={(e) => onLibraryQueryChange(e.target.value)}
          placeholder={t("whisper.filterPlaceholder")}
          aria-label={t("whisper.filterPlaceholder")}
          className="min-w-[180px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12px] text-[var(--text)] placeholder:text-[var(--text-3)]"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
          <input
            type="checkbox"
            checked={hideWithSubtitles}
            onChange={(e) => onHideWithSubtitlesChange(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          {t("whisper.hideWithSubtitles")}
        </label>
        <select
          aria-label={t("whisper.sortAriaLabel")}
          value={sortBy}
          onChange={(e) => onSortByChange(e.target.value as SortBy)}
          className={selectCls}
        >
          <option value="name">{t("whisper.sortByName")}</option>
          <option value="date">{t("whisper.sortByDate")}</option>
        </select>
        <ActionButton variant="ghost" size="sm" onClick={onToggleSortDir}>
          <span aria-hidden="true">{sortDir === "asc" ? "↑" : "↓"}</span>
          <span className="sr-only">{sortDir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}</span>
        </ActionButton>
        <ActionButton variant="ghost" size="sm" onClick={onSelectAll} disabled={running || visibleFiles.length === 0}>
          {t("whisper.selectAll")}
        </ActionButton>
        <ActionButton variant="ghost" size="sm" onClick={() => { void onRefreshScan(); }} disabled={isScanFetching} className="ml-auto">
          {isScanFetching
            ? <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" aria-hidden="true" />{t("whisper.scanning")}</>
            : <><span aria-hidden="true">↻</span> {t("whisper.refresh")}</>
          }
        </ActionButton>
      </div>

      {isFiltered && (
        <div className="text-[11px] text-[var(--text-3)]">
          {t("whisper.filteredCount", { shown: visibleFiles.length, total: videoFiles.length })}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {/* Run actions appear against a selection, matching the pattern
            ScanResultsPanel uses for the sibling scan flow. */}
        <SelectionBar
          count={selectedVisibleCount}
          isMobile={isMobile}
          summaryLabel={t("whisper.selectedSummary", { count: selectedVisibleCount })}
          hintLabel={t("whisper.overwriteHint")}
          clearLabel={t("whisper.clear")}
          onClear={onClearSelection}
        >
          <ActionButton
            variant="primary"
            size="sm"
            onClick={() => { void onTranscribeSelected(); }}
            disabled={running || downloadsActive}
            busy={running}
          >
            {running && progress
              ? t("whisper.transcribingProgress", { done: progress.done, total: progress.total })
              : t("whisper.transcribeSelected", { count: selectedVisibleCount })}
          </ActionButton>
          {running && (
            <ActionButton variant="danger" size="sm" onClick={() => { void onCancelBatch(); }}>
              {t("whisper.cancel")}
            </ActionButton>
          )}
        </SelectionBar>

        <div className="max-h-[45vh] overflow-y-auto">
          {isScanLoading && <EmptyHint text={t("whisper.scanning")} />}
          {!isScanLoading && videoFiles.length === 0 && <EmptyHint text={t("whisper.noVideos")} />}
          {!isScanLoading && videoFiles.length > 0 && visibleFiles.length === 0 && (
            <EmptyHint text={t("whisper.noMatchingVideos")} />
          )}
          {/* With a text filter, matches from any depth render as one flat
              list labelled by relative path, so hits are unambiguous. */}
          {!isScanLoading && filterActive && tree.allFiles.map((f) => (
            <FileRow
              key={f.videoPath as string}
              file={f}
              padLeftPx={12}
              relPath={relativeDisplayPath(f.videoPath as string)}
              selected={selected}
              toggleFile={toggleFile}
              fileProgress={fileProgress}
              activePath={activePath}
              running={running}
            />
          ))}
          {!isScanLoading && !filterActive && (
            <FileTreeView
              roots={tree.children}
              rootFiles={tree.files}
              isMobile={isMobile}
              expansion={expansion}
              drill={drill}
              homeLabel={t("common.home")}
              fileKey={(f) => f.videoPath as string}
              renderFolderRow={(node, ctx) => (
                <WhisperFolderRow node={node} ctx={ctx} selected={selected} running={running} toggleFolder={toggleFolder} />
              )}
              renderFile={(f, ctx: FileRowContext) => (
                <FileRow file={f} padLeftPx={ctx.padLeftPx} selected={selected} toggleFile={toggleFile} fileProgress={fileProgress} activePath={activePath} running={running} />
              )}
            />
          )}
        </div>
      </div>

      <span aria-live="polite" className="sr-only">
        {running && progress ? t("whisper.transcribingProgress", { done: progress.done, total: progress.total }) : ""}
      </span>
    </SettingsSection>
  );
}

interface FileRowProps {
  file: ScannedFile;
  padLeftPx: number;
  /** When set (filter mode), the row is labelled by relative path, not name. */
  relPath?: string;
  selected: Set<string>;
  toggleFile: (vp: string) => void;
  fileProgress: Record<string, FileProgress>;
  activePath: string | null;
  running: boolean;
}

function FileRow({ file, padLeftPx, relPath, selected, toggleFile, fileProgress, activePath, running }: FileRowProps) {
  const { t } = useTranslation();
  const vp = file.videoPath as string;
  const fp = fileProgress[vp];
  const isActive = activePath === vp;
  const status = fp?.done ? t("whisper.statusDone")
    : fp?.cancelled ? t("whisper.statusCancelled")
    : fp?.error ? t("whisper.statusError")
    : fp?.phase === "diarizing" ? t("whisper.diarizing")
    : typeof fp?.pct === "number" ? `${Math.round(fp.pct)}%` : "";
  return (
    <label className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
      style={{ paddingLeft: `${padLeftPx}px` }}>
      {/* Selection is frozen mid-batch: the run works from the list captured at
          start, so letting it change would misrepresent what is queued. */}
      <input type="checkbox" checked={selected.has(vp)} disabled={running} onChange={() => toggleFile(vp)} className="h-4 w-4 accent-[var(--accent)]" />
      <span className="truncate"><span aria-hidden="true">🎬</span> {relPath ?? (file.videoName || baseName(vp))}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {status && (
          // The running file is marked with a glyph + weight, not accent colour
          // alone, and announced so it isn't a purely visual distinction.
          <span className={`text-[10px] ${isActive ? "font-semibold text-[var(--accent)]" : "text-[var(--text-3)]"}`}>
            {isActive && <span aria-hidden="true">▶ </span>}
            {isActive && <span className="sr-only">{t("whisper.transcribingNow")} </span>}
            {status}
          </span>
        )}
        {file.subtitles.length > 0 && <span className="text-[10px] text-[var(--text-3)]">{t("whisper.hasSubtitle")}</span>}
      </span>
    </label>
  );
}

interface WhisperFolderRowProps {
  node: TreeNode;
  ctx: FolderRowContext;
  selected: Set<string>;
  running: boolean;
  toggleFolder: (paths: string[]) => void;
}

/**
 * Folder header content for the whisper library tree. Structure (indent,
 * rails, sticky slots, drill-down) comes from FileTreeView; this row only
 * renders the caret/checkbox/name controls at a fixed 36px height so the
 * sticky offsets in the view hold.
 */
function WhisperFolderRow({ node, ctx, selected, running, toggleFolder }: WhisperFolderRowProps) {
  const { t } = useTranslation();
  const allSel = node.allPaths.length > 0 && node.allPaths.every((p) => selected.has(p));
  const someSel = !allSel && node.allPaths.some((p) => selected.has(p));
  const isDrill = ctx.mode === "drill";
  return (
    <div className="flex h-9 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 text-[12px] font-medium text-[var(--text)]"
      style={{ paddingLeft: `${ctx.padLeftPx}px` }}>
      {/* The caret, the checkbox and the name button are three distinct
          controls; each needs a name describing its own action, or a screen
          reader just hears the folder name three times in a row. */}
      {!isDrill && (
        <button type="button" onClick={ctx.onActivate} className="w-3 shrink-0 text-[var(--text-3)]" aria-label={t("whisper.toggleFolder", { name: node.name })} aria-expanded={ctx.open}>
          <span aria-hidden="true">{ctx.open ? "▾" : "▸"}</span>
        </button>
      )}
      <input
        type="checkbox"
        aria-label={t("whisper.selectFolder", { name: node.name })}
        checked={allSel}
        disabled={running}
        ref={(el) => { if (el) el.indeterminate = someSel; }}
        onChange={() => toggleFolder(node.allPaths)}
        className="h-4 w-4 accent-[var(--accent)]"
      />
      <button
        type="button"
        onClick={ctx.onActivate}
        aria-label={isDrill ? t("common.openFolder", { name: node.name }) : t("whisper.toggleFolder", { name: node.name })}
        aria-expanded={isDrill ? undefined : ctx.open}
        className="flex min-w-0 flex-1 items-center gap-1 truncate text-left"
      >
        {/* From depth 2 the sticky stack stops growing, so pinned deep headers
            carry their ancestor path inline instead. */}
        {ctx.ancestorHint && <span className="shrink-0 text-[10px] font-normal text-[var(--text-3)]">{ctx.ancestorHint} /</span>}
        <span className="truncate"><span aria-hidden="true">📁</span> {node.name}</span>
        <span className="shrink-0 text-[10px] text-[var(--text-3)]">({node.allPaths.length})</span>
      </button>
      {isDrill && <span aria-hidden="true" className="shrink-0 text-[var(--text-3)]">›</span>}
    </div>
  );
}
