import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useModelDownload } from "../../hooks";
import { useToast } from "../../ui/Toast";
import { useConfirm } from "../../ui/ConfirmModal";
import { ActionButton, ProgressSmall } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import type { TranscriptionHost, WhisperModel, WhisperModelDownloadOperation } from "../../types";
import { engineLabelKey, groupByEngine, isMetal, modelEngine } from "../whisper/whisper-shared";
import { Icon } from "../../ui/Icon";

function formatMb(value?: number, unknownLabel = "—"): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return unknownLabel;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} GB`;
  return `${Math.round(value)} MB`;
}

const badgeCls = "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs";

// The backend can list a model whose engine cannot run here; its file can
// still be downloaded ahead of fixing the runtime, so only a badge flags it.
function ModelStatus({
  model,
  downloading,
  cancelling,
}: {
  model: WhisperModel;
  downloading: boolean;
  cancelling: boolean;
}) {
  const { t } = useTranslation();
  const download = model.download;
  const status = cancelling
    ? t("settings.models.downloadCancelling")
    : downloading
      ? t("settings.models.downloading")
      : download?.status === "cancelled"
        ? t("settings.models.downloadCancelled")
        : t("settings.models.notDownloaded");
  return (
    <div className="flex flex-wrap gap-1">
      {model.available === false && (
        <span
          className={`${badgeCls} border-danger-line bg-danger-soft text-danger`}
          title={model.unavailableReason ?? undefined}
        >
          <Icon name="error" />
          {t("settings.models.runtimeMissing")}
          {model.unavailableReason && <span className="sr-only">: {model.unavailableReason}</span>}
        </span>
      )}
      <div aria-live="polite">
        {downloading || !model.downloaded ? (
          <span className={`${badgeCls} border-border bg-surface-highlight text-muted`}>{status}</span>
        ) : (
          <span className={`${badgeCls} border-success-line bg-success-soft text-success`}>
            <Icon name="done" /> {t("settings.models.downloaded")}
          </span>
        )}
        {!downloading && !model.downloaded && download?.status === "failed" && (
          <p className="mt-1 max-w-64 break-words text-danger">
            {t("settings.models.downloadFailed", { model: model.label ?? model.id, message: download.error })}
          </p>
        )}
      </div>
    </div>
  );
}

function isActiveDownload(download?: WhisperModelDownloadOperation) {
  return download?.status === "running" || download?.status === "cancelling";
}

export function ModelManagerPanel({ enabled, host }: { enabled: boolean; host: TranscriptionHost }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const { downloads, downloadModel } = useModelDownload();
  const locallyDownloading = Object.values(downloads).some((download) => download.active);
  const modelsQuery = useQuery({
    queryKey: ["whisper-models"],
    queryFn: ({ signal }) => api.listWhisperModels({ signal }),
    enabled,
    staleTime: 15_000,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchInterval: (query) =>
      locallyDownloading || query.state.data?.models.some((model) => isActiveDownload(model.download)) ? 1_500 : 15_000,
  });

  const [busyDelete, setBusyDelete] = useState<Record<string, boolean>>({});
  const [pendingCancel, setPendingCancel] = useState<Record<string, boolean>>({});

  const handleDownload = async (model: string) => {
    try {
      await downloadModel(model);
      addToast(t("settings.models.downloadDone", { model }), "success");
    } catch (e: unknown) {
      if (!api.isWhisperModelDownloadCancelled(e)) {
        addToast(t("settings.models.downloadFailed", { model, message: getErrorMessage(e) }), "error");
      }
    }
  };

  const handleCancel = async (download: WhisperModelDownloadOperation) => {
    setPendingCancel((prev) => ({ ...prev, [download.id]: true }));
    try {
      await api.cancelWhisperModelDownload(download.id);
      await modelsQuery.refetch();
    } catch (e: unknown) {
      addToast(
        t("settings.models.downloadCancelFailed", { model: download.model, message: getErrorMessage(e) }),
        "error",
      );
    } finally {
      setPendingCancel((prev) => {
        const next = { ...prev };
        delete next[download.id];
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

  const groups = groupByEngine(
    (modelsQuery.data?.models ?? []).map((model) => ({ ...model, engine: model.engine ?? modelEngine(model.id) })),
    host,
  );
  // On a Mac the GPU shares system memory, so a VRAM figure says nothing the RAM column does not.
  const showVram = !isMetal(host);

  return (
    <div className="rounded-md border border-border bg-surface-raised p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-text">{t("settings.models.title")}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t("settings.models.description")}</p>
        </div>
        <ActionButton
          variant="ghost"
          size="sm"
          onClick={() => modelsQuery.refetch()}
          disabled={!enabled || modelsQuery.isFetching}
        >
          {modelsQuery.isFetching ? t("settings.models.refreshing") : t("settings.models.refresh")}
        </ActionButton>
      </div>

      {!enabled ? (
        <p className="mt-3 text-xs text-faint">{t("settings.models.needsBackend")}</p>
      ) : modelsQuery.isError ? (
        <div className="mt-3">
          <InlineError message={getErrorMessage(modelsQuery.error)} onRetry={() => void modelsQuery.refetch()} />
        </div>
      ) : modelsQuery.isLoading ? (
        <p className="mt-3 text-xs text-faint">{t("settings.models.loading")}</p>
      ) : groups.length === 0 ? (
        <p className="mt-3 text-xs text-faint">{t("settings.models.empty")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-faint">
                <th className="py-2 pr-3 font-medium">{t("settings.models.colModel")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.models.size")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.models.ram")}</th>
                {showVram && <th className="py-2 pr-3 font-medium">{t("settings.models.vram")}</th>}
                <th className="py-2 pr-3 font-medium">{t("settings.models.colStatus")}</th>
                <th className="py-2 pr-0 text-right font-medium">{t("settings.models.colActions")}</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.engine}>
                <tr className="border-t border-border">
                  <th
                    colSpan={showVram ? 6 : 5}
                    scope="colgroup"
                    className="pb-1 pt-3 text-left text-xs font-semibold text-muted"
                  >
                    {t(engineLabelKey(group.engine, host))}
                  </th>
                </tr>
                {group.items.map((model) => {
                  const dl = downloads[model.id];
                  const download = model.download;
                  const downloading = Boolean(dl?.active) || isActiveDownload(download);
                  const cancelling = Boolean(
                    download && (pendingCancel[download.id] || download.status === "cancelling"),
                  );
                  const pct = Math.max(dl?.pct ?? 0, isActiveDownload(download) ? (download?.progress?.pct ?? 0) : 0);
                  const deleting = Boolean(busyDelete[model.id]);
                  return (
                    <tr key={model.id} className="border-t border-border align-middle">
                      <td className="py-3 pr-3">
                        <span className="text-text">{model.label ?? model.id}</span>
                        {model.label && model.label !== model.id && (
                          <div className="mt-1 font-mono text-xs text-faint">{model.id}</div>
                        )}
                        {model.cachePath && <div className="mt-1 break-all text-xs text-faint">{model.cachePath}</div>}
                      </td>
                      <td className="py-3 pr-3 text-muted">{formatMb(model.sizeMb)}</td>
                      <td className="py-3 pr-3 text-muted">{formatMb(model.requiredRamMb)}</td>
                      {showVram && <td className="py-3 pr-3 text-muted">{formatMb(model.requiredVramMb)}</td>}
                      <td className="py-3 pr-3">
                        <ModelStatus model={model} downloading={downloading} cancelling={cancelling} />
                      </td>
                      <td className="py-3 pr-0">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {downloading ? (
                            <>
                              <div className="w-28">
                                <ProgressSmall pct={pct} large />
                              </div>
                              {download && isActiveDownload(download) && (
                                <ActionButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleCancel(download)}
                                  disabled={cancelling}
                                >
                                  {t("common.cancel")}
                                </ActionButton>
                              )}
                            </>
                          ) : model.downloaded ? (
                            <ActionButton
                              variant="danger"
                              size="sm"
                              onClick={() => handleDelete(model.id)}
                              disabled={deleting}
                            >
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
            ))}
          </table>
        </div>
      )}
    </div>
  );
}
