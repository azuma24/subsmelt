import { useId } from "react";
import type { TFunction } from "i18next";
import type { ScannedFile } from "../../types";
import { ModalShell } from "../../components/ModalShell";
import { Icon } from "../../ui/Icon";

export interface ScanFolderCount {
  name: string;
  count: number;
}

export interface ScanPlan {
  files: ScannedFile[];
  newJobs: number;
  topFolders: ScanFolderCount[];
}

const TOP_FOLDER_LIMIT = 3;

const targeted = (file: ScannedFile) => file.subtitles.filter((subtitle) => subtitle.tasks.length > 0);
const untargeted = (file: ScannedFile) => file.subtitles.filter((subtitle) => subtitle.tasks.length === 0);

/**
 * Source subtitles a translation target applies to: the population "will be
 * queued" refers to. The server's totalSubtitles also counts translated
 * outputs on disk and subtitles no target applies to.
 */
export function countScanSubtitles(files: ScannedFile[]): number {
  return files.reduce((total, file) => total + targeted(file).length, 0);
}

/** Source subtitles no translation target applies to. */
export function countUntargetedSubtitles(files: ScannedFile[]): number {
  return files.reduce((total, file) => total + untargeted(file).length, 0);
}

/** Subtitle count per parent folder, largest first; the same population as countScanSubtitles. */
export function summarizeScanFolders(files: ScannedFile[]): ScanFolderCount[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const subtitle of targeted(file)) {
      const chunks = subtitle.srtPath.replace(/\\/g, "/").split("/").filter(Boolean);
      const folder = chunks.length > 1 ? chunks[chunks.length - 2] : "root";
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_FOLDER_LIMIT);
}

interface ScanConfirmModalProps {
  scanPlan: ScanPlan;
  onClose: () => void;
  onConfirm: () => void;
  t: TFunction;
}

const SECONDARY_BUTTON = "rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm text-muted sm:col-span-1";
const PRIMARY_BUTTON = "rounded-sm bg-accent px-3 py-2 text-sm font-medium text-accent-text sm:col-span-1";

export function ScanConfirmModal({ scanPlan, onClose, onConfirm, t }: ScanConfirmModalProps) {
  const nothingNew = scanPlan.newJobs === 0;
  const subtitles = countScanSubtitles(scanPlan.files);
  const untargetedSubtitles = countUntargetedSubtitles(scanPlan.files);
  const noTargetApplies = subtitles === 0 && untargetedSubtitles > 0;
  const folders = scanPlan.topFolders.map((folder) => t("dashboard.scanConfirm.folderCount", { name: folder.name, count: folder.count }));
  const titleId = useId();
  return (
    <ModalShell
      labelledBy={titleId}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 bg-scrim p-4"
      panelClassName="mx-auto mt-16 w-full max-w-xl rounded-md border border-border bg-surface p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 id={titleId} className="pt-2 text-base font-semibold text-text">{t("dashboard.scanConfirm.title")}</h3>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-raised hover:text-text"
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          <Icon name="close" size={20} />
        </button>
      </div>
      <p className="mt-2 text-sm text-muted">
        {noTargetApplies
          ? t("dashboard.scanConfirm.summaryNoTarget", { subtitles: untargetedSubtitles })
          : nothingNew
          ? t("dashboard.scanConfirm.summaryNothingNew", { subtitles })
          : t("dashboard.scanConfirm.summary", { subtitles, jobs: scanPlan.newJobs })}
      </p>
      <div className="mt-3 rounded-sm border border-border bg-surface-raised p-3">
        <div className="text-xs text-faint">{t("dashboard.scanConfirm.topFolders")}</div>
        <div className="mt-1 text-sm text-text">{folders.length > 0 ? folders.join(", ") : t("dashboard.scanConfirm.none")}</div>
      </div>
      {/* With nothing to queue, closing is the primary action; a scan still
          refreshes the scan-results tab, so it stays reachable as secondary. */}
      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
        {nothingNew ? (
          <>
            <button onClick={onConfirm} className={SECONDARY_BUTTON}>{t("dashboard.scanConfirm.scanAnyway")}</button>
            <button onClick={onClose} className={PRIMARY_BUTTON}>{t("common.close")}</button>
          </>
        ) : (
          <>
            <button onClick={onClose} className={SECONDARY_BUTTON}>{t("common.cancel")}</button>
            <button onClick={onConfirm} className={PRIMARY_BUTTON}>{t("dashboard.scanConfirm.proceed")}</button>
          </>
        )}
      </div>
    </ModalShell>
  );
}
