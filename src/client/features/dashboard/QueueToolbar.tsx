import type { TFunction } from "i18next";
import type { DashboardTab, DashboardTabItem } from "./tabs";
import { Accordion, ActionButton, Tabs } from "../../ui/primitives";


interface QueueToolbarProps {
  dashboardTabs: DashboardTabItem[];
  activeTab: DashboardTab;
  onSelectTab: (key: DashboardTab) => void;
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

// Status filtering lives exclusively in the DashboardHero metric band. This
// toolbar used to render a second, differently-styled pill row bound to the very
// same `statusFilter`, so the two widgets disagreed visually while agreeing in
// state. The hero cells are the canonical selector and offered every value this
// row did (all / pending / translating / done / error), so nothing was lost.
export function QueueToolbar({
  dashboardTabs,
  activeTab,
  onSelectTab,
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
  const showTabs = dashboardTabs.length > 1;
  const showQueueControls = activeTab === "queue";
  if (!showTabs && !showQueueControls) return null;

  return (
    <div className="space-y-3 border-b border-[var(--border)] px-3.5 py-3">
      {/* One tab row only. The page heading in the topbar already names this
          screen, so the section title/subtitle that used to sit here was pure
          repetition and pushed the table further down. */}
      {showTabs && (
        <Tabs
          tabs={dashboardTabs}
          activeKey={activeTab}
          onSelect={(key) => onSelectTab(key as DashboardTab)}
        />
      )}

      {showQueueControls && (
        <>
          {/* Recovery / bulk actions: visible, not buried in the collapsed
              "Filters" accordion where they used to live. */}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("dashboard.bulkActionsLabel")}>
            <ActionButton
              size="sm"
              variant="ghost"
              onClick={onSelectVisiblePending}
              disabled={visiblePendingIds.length === 0}
            >
              {t("dashboard.selectVisiblePending", { count: visiblePendingIds.length })}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="warning"
              onClick={onRetryVisibleErrors}
              disabled={visibleErrorIds.length === 0}
              busy={isRetryPending}
            >
              {t("dashboard.retryVisibleErrors", { count: visibleErrorIds.length })}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="ghost"
              onClick={onRetranslateVisible}
              disabled={visibleRetranslatableIds.length === 0}
              busy={isForcePending}
            >
              {t("dashboard.retranslateVisible", { count: visibleRetranslatableIds.length })}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="danger"
              onClick={onClearAll}
              disabled={jobsCount === 0}
            >
              {t("dashboard.clearAll")}
            </ActionButton>
          </div>

          {/* L3: Filters accordion — folder + target selects + clear filters. */}
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
                <ActionButton
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  onClick={onClearFilters}
                  disabled={!hasQueueFilters}
                >
                  {t("dashboard.clearQueueFilters")}
                </ActionButton>
              </div>
            </div>
          </Accordion>
        </>
      )}
    </div>
  );
}
