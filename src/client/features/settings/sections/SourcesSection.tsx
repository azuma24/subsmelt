import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "../../../api";
import { getErrorMessage } from "../../../lib";
import { useToast } from "../../../ui/Toast";
import { useTranslation } from "../../../i18n";
import { Accordion, ActionButton, Field, Select } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { watcherLabelKey } from "../../../lib/watcher-status";
import { MediaSourcesPanel } from "../MediaSourcesPanel";
import { NotificationsFields } from "./NotificationsFields";
import { ToggleRow, labelCls } from "./shared";
import { WATCHER_STATUS_QUERY_KEY, useIsMobile, useWatcherStatusQuery } from "../../../hooks";

interface SourcesSectionProps {
  settings: Record<string, unknown>;
  /** Deferred writer — the Advanced fields here still wait for the topbar Save. */
  update: (key: string, value: unknown) => void;
  updateAndSave: (key: string, value: unknown) => void;
  updateManyAndSave: (updates: Record<string, unknown>) => void;
  updateAndSaveDebounced: (key: string, value: unknown) => void;
  onNotificationTest: () => void;
  testingNotification: boolean;
  notificationTestResult: { ok: boolean; message: string } | null;
}

/**
 * Sources & Monitoring.
 *
 * This section deliberately mixes both save mechanisms, exactly as it did
 * inline: the media-source pickers and the auto-translate toggle write through
 * `updateAndSave`/`updateManyAndSave` (immediate), while the four Advanced
 * fields (extensions, scan interval, token budget) use plain `update` and are
 * persisted by the topbar Save button.
 */
export function SourcesSection({
  settings,
  update,
  updateAndSave,
  updateManyAndSave,
  updateAndSaveDebounced,
  onNotificationTest,
  testingNotification,
  notificationTestResult,
}: SourcesSectionProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const watcherQuery = useWatcherStatusQuery();
  const watcher = watcherQuery.data;
  const [togglingWatcher, setTogglingWatcher] = useState(false);
  const statusDetails = [];
  if (!watcherQuery.isError && watcher?.running) {
    if (watcher.fileEvents === "watching") statusDetails.push(t("settings.sources.watcherFileEvents"));
    if (watcher.fileEvents === "starting") statusDetails.push(t("app.watcherStarting"));
    if (watcher.fileEvents === "unavailable") statusDetails.push(t("settings.sources.watcherFileEventsUnavailable"));
    if (watcher.pollIntervalMinutes > 0) {
      statusDetails.push(t("settings.sources.watcherPollCadence", { minutes: watcher.pollIntervalMinutes }));
    }
  }

  const toggleWatcher = async () => {
    if (!watcher || togglingWatcher) return;
    setTogglingWatcher(true);
    try {
      await api.setWatcherEnabled(!watcher.enabled);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WATCHER_STATUS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    } catch (error) {
      addToast(t("settings.watcherError", { message: getErrorMessage(error) }), "error");
    } finally {
      setTogglingWatcher(false);
    }
  };

  return (
    <>
      <MediaSourcesPanel
        mediaDir={str(settings._media_dir, "/media")}
        scanMode={str(settings.scan_mode, "recursive")}
        scanFolders={str(settings.scan_folders)}
        scanExcludeFolders={str(settings.scan_exclude_folders)}
        scanProfiles={str(settings.scan_profiles, "[]")}
        directoryRules={str(settings.directory_rules, "[]")}
        subtitleIntakeRules={str(settings.subtitle_intake_rules, "[]")}
        onScanModeChange={(mode) => updateAndSave("scan_mode", mode)}
        onScanFoldersChange={(folders) => updateAndSave("scan_folders", folders)}
        onScanExcludeFoldersChange={(folders) => updateAndSave("scan_exclude_folders", folders)}
        onScanScopeChange={(scope) =>
          updateManyAndSave({
            scan_mode: scope.scanMode,
            scan_folders: scope.scanFolders,
            scan_exclude_folders: scope.scanExcludeFolders,
          })
        }
        onScanProfilesChange={(profiles) => updateAndSave("scan_profiles", profiles)}
        onDirectoryRulesChange={(rules) => updateAndSave("directory_rules", rules)}
        onSubtitleIntakeRulesChange={(rules) => updateAndSave("subtitle_intake_rules", rules)}
      />
      <ToggleRow
        title={t("settings.sources.autoTranslate")}
        description={t("settings.sources.autoTranslateHint")}
        checked={str(settings.auto_translate, "1") === "1"}
        onChange={(checked) => updateAndSave("auto_translate", checked ? "1" : "0")}
      />
      <div className="space-y-2">
        <label htmlFor="preferred-chinese" className={labelCls}>
          {t("settings.sources.preferredChinese")}
        </label>
        <Select
          id="preferred-chinese"
          value={str(settings.preferred_chinese, "zh-TW")}
          onChange={(value) => updateAndSave("preferred_chinese", value)}
          className="min-h-touch md:max-w-[320px]"
        >
          <option value="zh-TW">{t("settings.sources.chineseTraditional")}</option>
          <option value="zh-CN">{t("settings.sources.chineseSimplified")}</option>
        </Select>
        <p className="text-xs leading-5 text-muted">{t("settings.sources.preferredChineseHint")}</p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-sm border border-border bg-surface-raised px-3 py-3">
        <div>
          <p className="text-sm font-medium text-text">{t("settings.sources.fileWatcher")}</p>
          <p className="mt-1 text-xs text-muted">{t("settings.sources.fileWatcherDesc")}</p>
          <p role="status" className="mt-2 text-xs text-muted">
            {[t(watcherLabelKey(watcher, watcherQuery.isError)), ...statusDetails].join(" · ")}
          </p>
        </div>
        <ActionButton
          variant={watcher?.enabled ? "ghost" : "success"}
          size="sm"
          disabled={!watcher || watcherQuery.isError || togglingWatcher}
          onClick={() => void toggleWatcher()}
        >
          {t(watcher?.enabled ? "settings.watcherPause" : "settings.watcherStart")}
        </ActionButton>
      </div>
      {/* Video/subtitle extensions + auto-scan interval → Advanced accordion */}
      <Accordion title={t("settings.advanced")}>
        <div className="space-y-4">
          <ToggleRow
            title={t("settings.sources.watcherFileEvents")}
            description={t("settings.sources.watcherFileEventsHint")}
            checked={str(settings.watch_enabled, "0") === "1"}
            onChange={(checked) => updateAndSave("watch_enabled", checked ? "1" : "0")}
          />
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
            <Field
              label={t("settings.sources.videoExtensions")}
              value={str(settings.video_extensions)}
              onChange={(v) => update("video_extensions", v)}
              help={t("settings.sources.videoExtensionsHint")}
            />
            <Field
              label={t("settings.sources.subtitleExtensions")}
              value={str(settings.subtitle_extensions)}
              onChange={(v) => update("subtitle_extensions", v)}
              help={t("settings.sources.subtitleExtensionsHint")}
            />
          </div>
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[420px]`}>
            <Field
              label={t("settings.sources.autoScanInterval")}
              value={str(settings.auto_scan_interval, "0")}
              onChange={(v) => update("auto_scan_interval", v)}
              help={t("settings.sources.autoScanIntervalHint")}
              type="number"
              min={0}
              max={10080}
            />
            <Field
              label={t("settings.sources.monthlyTokenBudget")}
              value={str(settings.monthly_token_budget, "0")}
              onChange={(v) => update("monthly_token_budget", v)}
              help={t("settings.sources.monthlyTokenBudgetHint")}
              type="number"
              min={0}
              max={1000000000000}
            />
          </div>
        </div>
      </Accordion>
      <NotificationsFields
        settings={settings}
        updateAndSave={updateAndSave}
        updateAndSaveDebounced={updateAndSaveDebounced}
        onTest={onNotificationTest}
        testing={testingNotification}
        testResult={notificationTestResult}
      />
    </>
  );
}
