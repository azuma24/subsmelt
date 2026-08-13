import { useTranslation } from "react-i18next";
import { Accordion, ActionButton, Field } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { MediaSourcesPanel } from "../MediaSourcesPanel";
import { NotificationsFields } from "./NotificationsFields";
import { ToggleRow, bool } from "./shared";

interface SourcesSectionProps {
  settings: Record<string, unknown>;
  isMobile: boolean;
  /** Deferred writer — the Advanced fields here still wait for the topbar Save. */
  update: (key: string, value: unknown) => void;
  updateAndSave: (key: string, value: unknown) => void;
  updateManyAndSave: (updates: Record<string, unknown>) => void;
  updateAndSaveDebounced: (key: string, value: unknown) => void;
  onToggleWatcher: () => void;
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
  isMobile,
  update,
  updateAndSave,
  updateManyAndSave,
  updateAndSaveDebounced,
  onToggleWatcher,
  onNotificationTest,
  testingNotification,
  notificationTestResult,
}: SourcesSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <MediaSourcesPanel
        isMobile={isMobile}
        mediaDir={str(settings._media_dir, "/media")}
        scanMode={str(settings.scan_mode, "recursive")}
        scanFolders={str(settings.scan_folders)}
        scanExcludeFolders={str(settings.scan_exclude_folders)}
        scanProfiles={str(settings.scan_profiles, "[]")}
        directoryRules={str(settings.directory_rules, "[]")}
        onScanModeChange={(mode) => updateAndSave("scan_mode", mode)}
        onScanFoldersChange={(folders) => updateAndSave("scan_folders", folders)}
        onScanExcludeFoldersChange={(folders) => updateAndSave("scan_exclude_folders", folders)}
        onScanScopeChange={(scope) => updateManyAndSave({
          scan_mode: scope.scanMode,
          scan_folders: scope.scanFolders,
          scan_exclude_folders: scope.scanExcludeFolders,
        })}
        onScanProfilesChange={(profiles) => updateAndSave("scan_profiles", profiles)}
        onDirectoryRulesChange={(rules) => updateAndSave("directory_rules", rules)}
      />
      <ToggleRow
        title={t("settings.sources.autoTranslate")}
        description={t("settings.sources.autoTranslateHint")}
        checked={str(settings.auto_translate, "1") === "1"}
        onChange={(checked) => updateAndSave("auto_translate", checked ? "1" : "0")}
      />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium text-[var(--text)]">{t("settings.sources.fileWatcher")}</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-2)]">{t("settings.sources.fileWatcherDesc")}</p>
        </div>
        <ActionButton variant={bool(settings._watcher_running) ? "success" : "ghost"} size="sm" onClick={onToggleWatcher}>{bool(settings._watcher_running) ? t("app.watcherActiveShort") : t("app.watcherInactiveShort")}</ActionButton>
      </div>
      {/* Video/subtitle extensions + auto-scan interval → Advanced accordion */}
      <Accordion title={t("settings.advanced")}>
        <div className="space-y-4">
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
            <Field label={t("settings.sources.videoExtensions")} value={str(settings.video_extensions)} onChange={(v) => update("video_extensions", v)} help={t("settings.sources.videoExtensionsHint")} />
            <Field label={t("settings.sources.subtitleExtensions")} value={str(settings.subtitle_extensions)} onChange={(v) => update("subtitle_extensions", v)} help={t("settings.sources.subtitleExtensionsHint")} />
          </div>
          <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[420px]`}>
            <Field label={t("settings.sources.autoScanInterval")} value={str(settings.auto_scan_interval, "0")} onChange={(v) => update("auto_scan_interval", v)} help={t("settings.sources.autoScanIntervalHint")} type="number" />
            <Field label={t("settings.sources.monthlyTokenBudget")} value={str(settings.monthly_token_budget, "0")} onChange={(v) => update("monthly_token_budget", v)} help={t("settings.sources.monthlyTokenBudgetHint")} type="number" />
          </div>
        </div>
      </Accordion>
      <NotificationsFields
        settings={settings}
        isMobile={isMobile}
        updateAndSave={updateAndSave}
        updateAndSaveDebounced={updateAndSaveDebounced}
        onTest={onNotificationTest}
        testing={testingNotification}
        testResult={notificationTestResult}
      />
    </>
  );
}
