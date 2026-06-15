import type { TFunction } from "i18next";
import type { ScannedFile } from "../../types";
import { ModalShell } from "../../components/ModalShell";

export interface ScanPlan {
  files: ScannedFile[];
  totalSubtitles: number;
  newJobs: number;
  topFolders: string[];
}

interface ScanConfirmModalProps {
  scanPlan: ScanPlan;
  onClose: () => void;
  onConfirm: () => void;
  t: TFunction;
}

export function ScanConfirmModal({ scanPlan, onClose, onConfirm, t }: ScanConfirmModalProps) {
  return (
    <ModalShell
      title={t("dashboard.scanConfirm.title")}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 bg-black/70 p-4"
      panelClassName="mx-auto mt-16 w-full max-w-xl rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6"
    >
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-sm text-[var(--text-2)] hover:text-[var(--text)]"
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          ×
        </button>
      </div>
      <p className="mt-2 text-[13px] text-[var(--text-2)]">{t("dashboard.scanConfirm.summary", { subtitles: scanPlan.totalSubtitles, jobs: scanPlan.newJobs })}</p>
      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div className="text-xs text-[var(--text-3)]">{t("dashboard.scanConfirm.topFolders")}</div>
        <div className="mt-1 text-[13px] text-[var(--text)]">{scanPlan.topFolders.length > 0 ? scanPlan.topFolders.join(", ") : t("dashboard.scanConfirm.none")}</div>
      </div>
      {/* sm:col-span-2 grid for the confirm buttons on small screens */}
      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
        <button onClick={onClose} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-2)] sm:col-span-1">{t("common.cancel")}</button>
        <button onClick={onConfirm} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white sm:col-span-1">{t("dashboard.scanConfirm.proceed")}</button>
      </div>
    </ModalShell>
  );
}
