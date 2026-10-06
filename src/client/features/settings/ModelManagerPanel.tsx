import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useModelDownload } from "../../hooks";
import { useToast } from "../../ui/Toast";
import { useConfirm } from "../../ui/ConfirmModal";
import { ActionButton, ProgressSmall } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import type { WhisperModel } from "../../types";
import { groupByEngine, modelEngine } from "../whisper/whisper-shared";
import { Icon } from "../../ui/Icon";

function formatMb(value?: number, unknownLabel = "—"): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return unknownLabel;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} GB`;
  return `${Math.round(value)} MB`;
}

const badgeCls = "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs";

// The backend can list a model whose engine cannot run here; its file can
// still be downloaded ahead of fixing the runtime, so only a badge flags it.
function ModelStatus({ model }: { model: WhisperModel }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {model.available === false && (
        <span className={`${badgeCls} border-danger-line bg-danger-soft text-danger`} title={model.unavailableReason ?? undefined}>
          <Icon name="error" />
          {t("settings.models.runtimeMissing")}
          {model.unavailableReason && <span className="sr-only">: {model.unavailableReason}</span>}
        </span>
      )}
      {model.downloaded ? (
        <span className={`${badgeCls} border-success-line bg-success-soft text-success`}>
          <Icon name="done" /> {t("settings.models.downloaded")}
        </span>
      ) : (
        <span className={`${badgeCls} border-border bg-surface-highlight text-muted`}>
          {t("settings.models.notDownloaded")}
        </span>
      )}
    </div>
  );
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

  // `pct` drives the inline progress bar; `active` disables the row's Download
  // button until the HTTP call settles (an SSE "done" alone must not clear it).
  const { downloads, downloadModel } = useModelDownload();
  const [busyDelete, setBusyDelete] = useState<Record<string, boolean>>({});

  const handleDownload = async (model: string) => {
    try {
      await downloadModel(model);
      addToast(t("settings.models.downloadDone", { model }), "success");
    } catch (e: unknown) {
      addToast(t("settings.models.downloadFailed", { model, message: getErrorMessage(e) }), "error");
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

  const groups = groupByEngine((modelsQuery.data?.models ?? []).map((model) => ({ ...model, engine: model.engine ?? modelEngine(model.id) })));

  return (
    <div className="rounded-md border border-border bg-surface-raised p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-text">{t("settings.models.title")}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t("settings.models.description")}</p>
        </div>
        <ActionButton variant="ghost" size="sm" onClick={() => modelsQuery.refetch()} disabled={!enabled || modelsQuery.isFetching}>
          {modelsQuery.isFetching ? t("settings.models.refreshing") : t("settings.models.refresh")}
        </ActionButton>
      </div>

      {!enabled ? (
        <p className="mt-3 text-xs text-faint">{t("settings.models.needsBackend")}</p>
      ) : modelsQuery.isError ? (
        <div className="mt-3">
          <InlineError onRetry={() => void modelsQuery.refetch()} />
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
                <th className="py-2 pr-3 font-medium">{t("settings.models.vram")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.models.colStatus")}</th>
                <th className="py-2 pr-0 text-right font-medium">{t("settings.models.colActions")}</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.engine}>
                <tr className="border-t border-border">
                  <th colSpan={6} scope="colgroup" className="pb-1 pt-3 text-left text-xs font-semibold text-muted">{t(`stt.engine.${group.engine}`)}</th>
                </tr>
                {group.items.map((model) => {
                  const dl = downloads[model.id];
                  const downloading = Boolean(dl?.active);
                  const deleting = Boolean(busyDelete[model.id]);
                  return (
                    <tr key={model.id} className="border-t border-border align-middle">
                      <td className="py-3 pr-3">
                        <span className="text-text">{model.label ?? model.id}</span>
                        {model.label && model.label !== model.id && (
                          <div className="mt-1 font-mono text-xs text-faint">{model.id}</div>
                        )}
                        {model.cachePath && (
                          <div className="mt-1 break-all text-xs text-faint">{model.cachePath}</div>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-muted">{formatMb(model.sizeMb)}</td>
                      <td className="py-3 pr-3 text-muted">{formatMb(model.requiredRamMb)}</td>
                      <td className="py-3 pr-3 text-muted">{formatMb(model.requiredVramMb)}</td>
                      <td className="py-3 pr-3"><ModelStatus model={model} /></td>
                      <td className="py-3 pr-0">
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
            ))}
          </table>
        </div>
      )}
    </div>
  );
}
