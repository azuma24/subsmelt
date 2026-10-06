import type { TFunction } from "i18next";
import type { DashboardTab, DashboardTabItem } from "./tabs";
import { Accordion, ActionButton, Tabs, Select } from "../../ui/primitives";

const chipClass = "w-full md:w-auto";

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
  finishedJobCount: number;
  isRetryPending: boolean;
  isForcePending: boolean;
  onSelectVisiblePending: () => void;
  onRetryVisibleErrors: () => void;
  onRetranslateVisible: () => void;
  onClearFinished: () => void;
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
  finishedJobCount,
  isRetryPending,
  isForcePending,
  onSelectVisiblePending,
  onRetryVisibleErrors,
  onRetranslateVisible,
  onClearFinished,
  t,
}: QueueToolbarProps) {
  const showTabs = dashboardTabs.length > 1;
  const showQueueControls = activeTab === "queue";
  if (!showTabs && !showQueueControls) return null;

  return (
    <div className="space-y-3 border-b border-border px-4 py-3">
      {/* One tab row only. The page heading in the topbar already names this
          screen, so the section title/subtitle that used to sit here was pure
          repetition and pushed the table further down. */}
      {showTabs && (
        <Tabs tabs={dashboardTabs} activeKey={activeTab} onSelect={(key) => onSelectTab(key as DashboardTab)} />
      )}

      {showQueueControls && (
        <>
          {/* Recovery / bulk actions: visible, not buried in the collapsed
              "Filters" accordion where they used to live. A zero-count action
              is hidden rather than rendered disabled — four gray buttons above
              the list were pure noise when nothing was actionable. */}
          {(visiblePendingIds.length > 0 ||
            visibleErrorIds.length > 0 ||
            visibleRetranslatableIds.length > 0 ||
            finishedJobCount > 0) && (
            <div
              // Phones get an even two-column grid so every action stays
              // visible without ragged wrapping; desktop wraps as before.
              className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center"
              role="group"
              aria-label={t("dashboard.bulkActionsLabel")}
            >
              {visiblePendingIds.length > 0 && (
                <ActionButton className={chipClass} size="sm" variant="ghost" onClick={onSelectVisiblePending}>
                  {t("dashboard.selectVisiblePending", { count: visiblePendingIds.length })}
                </ActionButton>
              )}
              {visibleErrorIds.length > 0 && (
                <ActionButton
                  className={chipClass}
                  size="sm"
                  variant="warning"
                  onClick={onRetryVisibleErrors}
                  busy={isRetryPending}
                >
                  {t("dashboard.retryVisibleErrors", { count: visibleErrorIds.length })}
                </ActionButton>
              )}
              {visibleRetranslatableIds.length > 0 && (
                <ActionButton
                  className={chipClass}
                  size="sm"
                  variant="ghost"
                  onClick={onRetranslateVisible}
                  busy={isForcePending}
                >
                  {t("dashboard.retranslateVisible", { count: visibleRetranslatableIds.length })}
                </ActionButton>
              )}
              {finishedJobCount > 0 && (
                <ActionButton className={chipClass} size="sm" variant="danger" onClick={onClearFinished}>
                  {t("dashboard.clearAll")}
                </ActionButton>
              )}
            </div>
          )}

          {/* L3: Filters accordion — folder + target selects + clear filters. */}
          <Accordion title={t("dashboard.filtersLabel")} defaultOpen={hasQueueFilters}>
            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <label className="min-w-0">
                <span className="mb-1 block text-xs uppercase tracking-wide text-faint">
                  {t("dashboard.queueFilterFolder")}
                </span>
                <Select value={folderFilter} onChange={(value) => onFolderFilterChange(value)}>
                  <option value="all">{t("dashboard.queueFilterAllFolders")}</option>
                  {folderOptions.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="min-w-0">
                <span className="mb-1 block text-xs uppercase tracking-wide text-faint">
                  {t("dashboard.queueFilterTarget")}
                </span>
                <Select value={targetFilter} onChange={(value) => onTargetFilterChange(value)}>
                  <option value="all">{t("dashboard.queueFilterAllTargets")}</option>
                  {targetOptions.map((target) => (
                    <option key={target} value={target}>
                      {target}
                    </option>
                  ))}
                </Select>
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
