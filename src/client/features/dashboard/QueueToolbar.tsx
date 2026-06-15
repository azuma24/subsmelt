import type { TFunction } from "i18next";
import { Accordion } from "../../ui/primitives";

type DashboardTab = "queue" | "transcription" | "scan";

interface FilterTab {
  key: string;
  label: string;
  count: number;
}

interface DashboardTabItem {
  key: DashboardTab;
  label: string;
  count: number;
}

interface QueueToolbarProps {
  dashboardTabs: DashboardTabItem[];
  filterTabs: FilterTab[];
  activeTab: DashboardTab;
  statusFilter: string;
  onSelectTab: (key: DashboardTab) => void;
  onSelectStatusFilter: (key: string) => void;
  hasQueueFilters: boolean;
  folderFilter: string;
  targetFilter: string;
  folderOptions: string[];
  targetOptions: string[];
  onFolderFilterChange: (value: string) => void;
  onTargetFilterChange: (value: string) => void;
  onClearFilters: () => void;
  visiblePendingIds: number[];
  visibleErrorIds: number[];
  visibleRetranslatableIds: number[];
  jobsCount: number;
  isRetryPending: boolean;
  isForcePending: boolean;
  onSelectVisiblePending: () => void;
  onRetryVisibleErrors: () => void;
  onRetranslateVisible: () => void;
  onClearAll: () => void;
  t: TFunction;
}

function FilterTabButtons({
  filterTabs,
  statusFilter,
  onSelectStatusFilter,
}: {
  filterTabs: FilterTab[];
  statusFilter: string;
  onSelectStatusFilter: (key: string) => void;
}) {
  return (
    <div className="inline-flex w-fit gap-px overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-[2px]">
      {filterTabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onSelectStatusFilter(tab.key)}
          className={`whitespace-nowrap rounded-[6px] px-[11px] py-[3px] text-[12px] transition-colors ${statusFilter === tab.key ? "bg-[var(--surface-3)] font-medium text-[var(--text)]" : "text-[var(--text-2)] hover:text-[var(--text)]"}`}
        >
          {tab.label}
          {tab.count > 0 && <span className={`ml-1 text-[11px] ${tab.key === "error" ? "text-[var(--red)]" : "text-[var(--text-3)]"}`}>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function QueueToolbar({
  dashboardTabs,
  filterTabs,
  activeTab,
  statusFilter,
  onSelectTab,
  onSelectStatusFilter,
  hasQueueFilters,
  folderFilter,
  targetFilter,
  folderOptions,
  targetOptions,
  onFolderFilterChange,
  onTargetFilterChange,
  onClearFilters,
  visiblePendingIds,
  visibleErrorIds,
  visibleRetranslatableIds,
  jobsCount,
  isRetryPending,
  isForcePending,
  onSelectVisiblePending,
  onRetryVisibleErrors,
  onRetranslateVisible,
  onClearAll,
  t,
}: QueueToolbarProps) {
  return (
    <div className="space-y-3 border-b border-[var(--border)] px-3.5 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-[13.5px] font-semibold text-[var(--text)]">{t("app.queueSectionTitle")}</h2>
          <p className="text-pretty text-sm text-[var(--text-3)]">{t("app.queueSectionSubtitle")}</p>
        </div>
        {/* Dashboard tabs: Queue / Transcription / Scan results */}
        {dashboardTabs.length > 1 && (
          <div className="inline-flex w-fit gap-px overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-[2px]">
            {dashboardTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => onSelectTab(tab.key)}
                className={`whitespace-nowrap rounded-[6px] px-[11px] py-[3px] text-[12px] transition-colors ${activeTab === tab.key ? "bg-[var(--surface-3)] font-medium text-[var(--text)]" : "text-[var(--text-2)] hover:text-[var(--text)]"}`}
              >
                {tab.label}
                {tab.count > 0 && <span className={`ml-1 text-[11px] ${tab.key === "error" ? "text-[var(--red)]" : "text-[var(--text-3)]"}`}>{tab.count}</span>}
              </button>
            ))}
          </div>
        )}
        {/* When only one tab, show status filter tabs */}
        {dashboardTabs.length === 1 && (
          <FilterTabButtons filterTabs={filterTabs} statusFilter={statusFilter} onSelectStatusFilter={onSelectStatusFilter} />
        )}
      </div>

      {/* Queue tab: status filter tabs (when multi-tab mode) */}
      {activeTab === "queue" && dashboardTabs.length > 1 && (
        <FilterTabButtons filterTabs={filterTabs} statusFilter={statusFilter} onSelectStatusFilter={onSelectStatusFilter} />
      )}

      {/* L3: Filters accordion (folder + target + clear) */}
      {activeTab === "queue" && (
        <Accordion title={t("dashboard.filtersLabel")} defaultOpen={hasQueueFilters}>
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <label className="min-w-0">
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--text-3)]">{t("dashboard.queueFilterFolder")}</span>
              <select
                value={folderFilter}
                onChange={(e) => onFolderFilterChange(e.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text)]"
              >
                <option value="all">{t("dashboard.queueFilterAllFolders")}</option>
                {folderOptions.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
              </select>
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--text-3)]">{t("dashboard.queueFilterTarget")}</span>
              <select
                value={targetFilter}
                onChange={(e) => onTargetFilterChange(e.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text)]"
              >
                <option value="all">{t("dashboard.queueFilterAllTargets")}</option>
                {targetOptions.map((target) => <option key={target} value={target}>{target}</option>)}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={onClearFilters}
                disabled={!hasQueueFilters}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)] disabled:opacity-40"
              >
                {t("dashboard.clearQueueFilters")}
              </button>
            </div>
          </div>
          {/* Bulk action buttons — kept accessible here in the filters accordion */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onSelectVisiblePending}
              disabled={visiblePendingIds.length === 0}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)] disabled:opacity-40"
            >
              {t("dashboard.selectVisiblePending", { count: visiblePendingIds.length })}
            </button>
            <button
              type="button"
              onClick={onRetryVisibleErrors}
              disabled={visibleErrorIds.length === 0 || isRetryPending}
              className="rounded-lg border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-3 py-2 text-xs font-medium text-[var(--yellow)] disabled:opacity-40"
            >
              {t("dashboard.retryVisibleErrors", { count: visibleErrorIds.length })}
            </button>
            <button
              type="button"
              onClick={onRetranslateVisible}
              disabled={visibleRetranslatableIds.length === 0 || isForcePending}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)] disabled:opacity-40"
            >
              {t("dashboard.retranslateVisible", { count: visibleRetranslatableIds.length })}
            </button>
            <button
              type="button"
              onClick={onClearAll}
              disabled={jobsCount === 0}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-2)] disabled:opacity-40"
            >
              {t("dashboard.clearAll")}
            </button>
          </div>
        </Accordion>
      )}
    </div>
  );
}
