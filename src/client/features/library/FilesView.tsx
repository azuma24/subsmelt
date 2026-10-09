import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { str } from "../../lib/settings-value";
import {
  LIBRARY_QUERY_KEY,
  useJobsQuery,
  useLibraryQuery,
  useMutationWithInvalidation,
  useSettingsQuery,
} from "../../hooks";
import { useToast } from "../../ui/Toast";
import type { Job, ScanResult, TaskStatus } from "../../types";
import { ActionButton, SelectionBar } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { InlineError } from "../../ui/QueryState";
import type { UseManualTranscriptionResult } from "../dashboard/useManualTranscription";
import {
  buildLibraryView,
  flattenRows,
  itemJobIds,
  itemStatus,
  type LibraryFilter,
  type LibraryItem,
  type LibrarySection,
} from "./library-model";
import { SortControls, type SortBy, type SortDir } from "../../ui/SortControls";
import { withQueuedTask } from "./task-status";
import { LibraryList, type FocusRequest } from "./LibraryList";
import { LibraryRowsSkeleton } from "./LibraryRows";
import { LibraryPanel } from "./LibraryPanel";
import { StatusChips } from "./StatusChips";
import { LibraryEmpty, LibraryLoadError, LibraryNotice } from "./LibraryStates";

const toggleIn = (set: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

const validSortBy = (value: unknown): SortBy => (value === "name" || value === "date" ? value : "date");
const validSortDir = (value: unknown): SortDir => (value === "asc" || value === "desc" ? value : "desc");

interface FilesViewProps {
  items: LibraryItem[];
  jobsById: Map<number, Job>;
  filter: LibraryFilter;
  onFilterChange: (filter: LibraryFilter) => void;
  transcription: UseManualTranscriptionResult;
  onPreview: (jobId: number) => void;
  onOpenJob: (jobId: number) => void;
}

export function FilesView({
  items,
  jobsById,
  filter,
  onFilterChange,
  transcription,
  onPreview,
  onOpenJob,
}: FilesViewProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const libraryQuery = useLibraryQuery();
  const jobsQuery = useJobsQuery();
  const settingsQuery = useSettingsQuery();
  const runPendingMutation = useMutationWithInvalidation((ids: number[]) => api.startQueue(ids));
  const searchRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  const settings = settingsQuery.data || {};
  // One sort preference for the whole app: the Library seeds from, and writes
  // through to, the same settings keys the Transcribe page's picker uses.
  // Local state changes immediately; the setting makes it survive a reload.
  const persistSetting = useMutationWithInvalidation((patch: Record<string, string>) => api.saveSettings(patch));
  const [sortBy, setSortBy] = useState<SortBy>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  useEffect(() => {
    if (!settingsQuery.isSuccess) return;
    setSortBy(validSortBy(settings.transcription_sort_by));
    setSortDir(validSortDir(settings.transcription_sort_dir));
  }, [settings.transcription_sort_by, settings.transcription_sort_dir, settingsQuery.isSuccess]);
  const handleSortByChange = useCallback(
    (value: SortBy) => {
      setSortBy(value);
      persistSetting.mutate({ transcription_sort_by: value });
    },
    [persistSetting],
  );
  const toggleSortDir = useCallback(() => {
    setSortDir((current) => {
      const next: SortDir = current === "asc" ? "desc" : "asc";
      persistSetting.mutate({ transcription_sort_dir: next });
      return next;
    });
  }, [persistSetting]);
  const transcriptionEnabled = str(settings.transcription_enabled, "0") === "1";
  const view = useMemo(
    () => buildLibraryView(items, jobsById, filter, query, sortBy, sortDir),
    [items, jobsById, filter, query, sortBy, sortDir],
  );
  const rows = useMemo(() => flattenRows(view.sections, collapsed), [view.sections, collapsed]);
  const openItem = openKey === null ? undefined : items.find((item) => item.key === openKey);
  const firstItemKey = rows.find((row) => row.type === "item")?.entry.item.key ?? null;
  const focusKey =
    openItem && rows.some((row) => row.type === "item" && row.entry.item.key === openKey) ? openKey : firstItemKey;

  // Ticks survive a filter or search change, but bulk actions only touch files
  // still on screen: acting on a file the person cannot see is worse than
  // forgetting it was ticked.
  const selected = view.sections
    .flatMap((section) => section.items.map((entry) => entry.item))
    .filter((item) => checked.has(item.key));
  const transcribablePaths = transcriptionEnabled
    ? selected.filter((item) => itemStatus(item, jobsById) === "needsTranscription").map((item) => item.key)
    : [];
  const pendingIds = selected.flatMap((item) => itemJobIds(item, jobsById, "pending"));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.closest("input, textarea, select, [contenteditable]") || document.querySelector('[aria-modal="true"]'))
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const closePanel = useCallback(() => {
    if (openKey) setFocusRequest({ key: openKey });
    setOpenKey(null);
  }, [openKey]);
  const toggleChecked = useCallback((key: string) => setChecked((prev) => toggleIn(prev, key)), []);
  const toggleCollapsed = useCallback((key: string) => setCollapsed((prev) => toggleIn(prev, key)), []);
  const toggleSection = useCallback((section: LibrarySection) => {
    setChecked((prev) => {
      const keys = section.items.map((entry) => entry.item.key);
      const next = new Set(prev);
      const all = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (all) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, []);
  // Every row currently listed — the filter and search already applied — so
  // bulk actions can never touch a file the person cannot see.
  const selectAllVisible = useCallback(() => {
    setChecked(new Set(view.sections.flatMap((section) => section.items.map((entry) => entry.item.key))));
  }, [view.sections]);
  const handleQueued = useCallback(
    (srtPath: string, task: TaskStatus) => {
      queryClient.setQueryData<ScanResult>(
        LIBRARY_QUERY_KEY,
        (prev) => prev && { ...prev, files: withQueuedTask(prev.files, srtPath, task) },
      );
    },
    [queryClient],
  );

  const runPending = () => {
    runPendingMutation.mutate(pendingIds, {
      onSuccess: () => {
        addToast(t("dashboard.toast.runSelectedStarted", { count: pendingIds.length }), "info");
        setChecked(new Set());
      },
      onError: (e) => addToast(getErrorMessage(e), "error"),
    });
  };
  const transcribeSelected = () => {
    setChecked(new Set());
    void transcription.handleBatchTranscribe(transcribablePaths, "transcribe_only");
  };

  // Statuses need jobs, and folders need the media root from settings.
  const loading = [libraryQuery, jobsQuery, settingsQuery].some((query) => query.isPending && !query.isError);
  const files = libraryQuery.data?.files;

  const body = (() => {
    if (libraryQuery.isError && !files) {
      return (
        <LibraryLoadError message={getErrorMessage(libraryQuery.error)} onRetry={() => void libraryQuery.refetch()} />
      );
    }
    if (loading) return <LibraryRowsSkeleton />;
    if (!files || files.length === 0) return <LibraryEmpty />;
    if (view.counts.all === 0) {
      return (
        <LibraryNotice title={t("library.noResults.title", { query: query.trim() })} body={t("library.noResults.body")}>
          <ActionButton variant="ghost" size="sm" onClick={() => setQuery("")}>
            {t("library.noResults.clear")}
          </ActionButton>
        </LibraryNotice>
      );
    }
    if (rows.length === 0)
      return <LibraryNotice title={t("library.noneInFilter", { filter: t(`library.filter.${filter}`) })} />;
    return (
      <LibraryList
        rows={rows}
        jobsById={jobsById}
        checked={checked}
        openKey={openItem ? openKey : null}
        focusKey={focusKey}
        focusRequest={focusRequest}
        onToggleChecked={toggleChecked}
        onToggleSection={toggleSection}
        onToggleCollapsed={toggleCollapsed}
        onOpen={setOpenKey}
      />
    );
  })();

  return (
    // The list scrolls on its own; the floor keeps it usable when the band and setup cards above are tall.
    <div className="flex min-h-[50dvh] flex-1">
      <section aria-label={t("library.view.files")} className="flex min-w-0 flex-1 flex-col">
        {files && files.length > 0 && (
          <div className="shrink-0 space-y-2 border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <label className="flex min-h-touch min-w-0 flex-1 items-center gap-2 rounded-sm border border-border bg-surface-raised px-3 focus-within:border-accent">
                <Icon name="search" className="text-muted" />
                <span className="sr-only">{t("library.searchLabel")}</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("library.search")}
                  className="min-w-0 flex-1 bg-transparent text-sm text-text outline-hidden placeholder:text-muted"
                />
                <kbd className="hidden rounded-sm border border-border px-1 font-mono text-xs text-muted sm:inline">
                  /
                </kbd>
              </label>
              <SortControls
                sortBy={sortBy}
                sortDir={sortDir}
                onSortByChange={handleSortByChange}
                onToggleSortDir={toggleSortDir}
              />
            </div>
            <div className="flex items-center gap-2">
              {/* Clips the chips' edge-to-edge scroll so it ends before Select all. */}
              <div className="min-w-0 flex-1 overflow-hidden">
                <StatusChips counts={view.counts} active={filter} onSelect={onFilterChange} />
              </div>
              <button
                type="button"
                onClick={selectAllVisible}
                disabled={view.counts.all === 0}
                className="min-h-touch shrink-0 px-2 text-sm font-medium text-accent hover:underline disabled:text-faint disabled:no-underline"
              >
                {t("whisper.selectAll")}
              </button>
            </div>
          </div>
        )}
        {jobsQuery.isError && (
          <div className="p-4 pb-0">
            <InlineError
              message={t("dashboard.queueLoadFailed", { message: getErrorMessage(jobsQuery.error) })}
              onRetry={() => void jobsQuery.refetch()}
            />
          </div>
        )}
        <SelectionBar
          count={selected.length}
          summaryLabel={t("library.bulk.summary", { count: selected.length })}
          onClear={() => setChecked(new Set())}
          clearLabel={t("library.bulk.clear")}
        >
          {transcribablePaths.length > 0 && (
            <ActionButton size="sm" variant="ghost" onClick={transcribeSelected}>
              {t("library.bulk.transcribe", { count: transcribablePaths.length })}
            </ActionButton>
          )}
          {pendingIds.length > 0 && (
            <ActionButton size="sm" variant="ghost" onClick={runPending} busy={runPendingMutation.isPending}>
              {t("library.bulk.runPending", { count: pendingIds.length })}
            </ActionButton>
          )}
        </SelectionBar>
        {body}
        {rows.length > 0 && (
          <p className="hidden shrink-0 border-t border-border px-4 py-2 text-xs text-muted lg:block">
            {t("library.keyboardHint")}
          </p>
        )}
      </section>
      {openItem && (
        <LibraryPanel
          item={openItem}
          jobsById={jobsById}
          transcriptionEnabled={transcriptionEnabled}
          transcription={transcription}
          onClose={closePanel}
          onPreview={onPreview}
          onQueued={handleQueued}
          onOpenJob={onOpenJob}
        />
      )}
    </div>
  );
}
