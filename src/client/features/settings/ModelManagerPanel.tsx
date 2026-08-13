import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useSSE } from "../../hooks";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { ActionButton, ProgressSmall } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import type { WhisperModel } from "../../types";

function formatMb(value?: number, unknownLabel = "—"): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return unknownLabel;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} GB`;
  return `${Math.round(value)} MB`;
}

// Per-model live download state, keyed by model id. `pct` drives the inline
// progress bar; `active` disables the row's Download button until it settles.
interface DownloadState {
  active: boolean;
  pct: number;
}

export function ModelManagerPanel({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const modelsQuery = useQuery({
    queryKey: ["whisper-models"],
    queryFn: ({ signal }) => api.listWhisperModels({ signal }),
    enabled,
    staleTime: 15_000,
  });

  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [busyDelete, setBusyDelete] = useState<Record<string, boolean>>({});

  // Live download progress arrives over SSE as { model, pct, ... } and terminal
  // { model, done } / { model, error }. We match by model id and patch state.
  // The HTTP POST below resolves with the terminal result for the toast; the
  // SSE feed is purely for the progress bar.
  useSSE(
    useCallback((type, data) => {
      if (type !== "model:download") return;
      const model = typeof data.model === "string" ? data.model : "";
      if (!model) return;
      if (data.error === true || data.done === true) {
        setDownloads((prev) => {
          const next = { ...prev };
          delete next[model];
          return next;
        });
        return;
      }
      if (typeof data.pct === "number") {
        const pct = Math.max(0, Math.min(100, data.pct));
        setDownloads((prev) => ({ ...prev, [model]: { active: true, pct } }));
      }
    }, []),
  );

  const handleDownload = async (model: string) => {
    setDownloads((prev) => ({ ...prev, [model]: { active: true, pct: prev[model]?.pct ?? 0 } }));
    try {
      await api.downloadWhisperModel(model);
      addToast(t("settings.models.downloadDone", { model }), "success");
      void modelsQuery.refetch();
    } catch (e: unknown) {
      addToast(t("settings.models.downloadFailed", { model, message: getErrorMessage(e) }), "error");
    } finally {
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[model];
        return next;
      });
    }
  };

  const handleDelete = async (model: string) => {
    const ok = await confirm({
      title: t("settings.models.deleteTitle"),
      message: t("settings.models.deleteConfirm", { model }),
      confirmLabel: t("settings.models.delete"),
      danger: true,
    });
    if (!ok) return;
    setBusyDelete((prev) => ({ ...prev, [model]: true }));
    try {
      const result = await api.deleteWhisperModel(model);
      addToast(t("settings.models.deleteDone", { model, freed: formatMb(result.freedMb) }), "success");
      void modelsQuery.refetch();
    } catch (e: unknown) {
      addToast(t("settings.models.deleteFailed", { model, message: getErrorMessage(e) }), "error");
    } finally {
      setBusyDelete((prev) => {
        const next = { ...prev };
        delete next[model];
        return next;
      });
    }
  };

  const models = modelsQuery.data?.models ?? [];

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-[var(--text)]">{t("settings.models.title")}</div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-2)]">{t("settings.models.description")}</p>
        </div>
        <ActionButton variant="ghost" size="sm" onClick={() => modelsQuery.refetch()} disabled={!enabled || modelsQuery.isFetching}>
          {modelsQuery.isFetching ? t("settings.models.refreshing") : t("settings.models.refresh")}
        </ActionButton>
      </div>

      {!enabled ? (
        <p className="mt-3 text-xs text-[var(--text-3)]">{t("settings.models.needsBackend")}</p>
      ) : modelsQuery.isError ? (
        <div className="mt-3">
          <InlineError onRetry={() => void modelsQuery.refetch()} />
        </div>
      ) : modelsQuery.isLoading ? (
        <p className="mt-3 text-xs text-[var(--text-3)]">{t("settings.models.loading")}</p>
      ) : models.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--text-3)]">{t("settings.models.empty")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-[var(--text-3)]">
                <th className="py-2 pr-3 font-medium">{t("settings.models.colModel")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.models.size")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.models.ram")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.models.vram")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.models.colStatus")}</th>
                <th className="py-2 pr-0 text-right font-medium">{t("settings.models.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model: WhisperModel) => {
                const dl = downloads[model.id];
                const downloading = Boolean(dl?.active);
                const deleting = Boolean(busyDelete[model.id]);
                return (
                  <tr key={model.id} className="border-t border-[var(--border)] align-middle">
                    <td className="py-2.5 pr-3">
                      <span className="font-mono text-[var(--text)]">{model.id}</span>
                      {model.cachePath && (
                        <div className="mt-0.5 break-all text-[10px] text-[var(--text-3)]">{model.cachePath}</div>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-[var(--text-2)]">{formatMb(model.sizeMb)}</td>
                    <td className="py-2.5 pr-3 text-[var(--text-2)]">{formatMb(model.requiredRamMb)}</td>
                    <td className="py-2.5 pr-3 text-[var(--text-2)]">{formatMb(model.requiredVramMb)}</td>
                    <td className="py-2.5 pr-3">
                      {model.downloaded ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--green-border)] bg-[var(--green-dim)] px-2 py-0.5 text-[10.5px] text-[var(--green)]">
                          ✓ {t("settings.models.downloaded")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-3)] px-2 py-0.5 text-[10.5px] text-[var(--text-2)]">
                          {t("settings.models.notDownloaded")}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-0">
                      <div className="flex items-center justify-end gap-2">
                        {downloading ? (
                          <div className="w-28">
                            <ProgressSmall pct={dl?.pct ?? 0} large />
                          </div>
                        ) : model.downloaded ? (
                          <ActionButton variant="danger" size="sm" onClick={() => handleDelete(model.id)} disabled={deleting}>
                            {deleting ? t("settings.models.deleting") : t("settings.models.delete")}
                          </ActionButton>
                        ) : (
                          <ActionButton size="sm" onClick={() => handleDownload(model.id)} disabled={downloading}>
                            {t("settings.models.download")}
                          </ActionButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
