import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useModelDownload } from "../../hooks";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { ActionButton, ProgressSmall } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import type { WhisperModel } from "../../types";
import { groupByEngine, modelEngine } from "../whisper/whisper-shared";

function formatMb(value?: number, unknownLabel = "—"): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return unknownLabel;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} GB`;
  return `${Math.round(value)} MB`;
}

const badgeCls = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]";

// The backend can list a model whose engine cannot run here; its file can
// still be downloaded ahead of fixing the runtime, so only a badge flags it.
function ModelStatus({ model }: { model: WhisperModel }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {model.available === false && (
        <span className={`${badgeCls} border-[var(--red-border)] bg-[var(--red-dim)] text-[var(--red)]`} title={model.unavailableReason ?? undefined}>
          <span aria-hidden="true">✗</span>
          {t("settings.models.runtimeMissing")}
          {model.unavailableReason && <span className="sr-only">: {model.unavailableReason}</span>}
        </span>
      )}
      {model.downloaded ? (
        <span className={`${badgeCls} border-[var(--green-border)] bg-[var(--green-dim)] text-[var(--green)]`}>
          ✓ {t("settings.models.downloaded")}
        </span>
      ) : (
        <span className={`${badgeCls} border-[var(--border)] bg-[var(--surface-3)] text-[var(--text-2)]`}>
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
      ) : groups.length === 0 ? (
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
            {groups.map((group) => (
              <tbody key={group.engine}>
                <tr className="border-t border-[var(--border)]">
                  <th colSpan={6} scope="colgroup" className="pb-1 pt-3 text-left text-[11px] font-semibold text-[var(--text-2)]">{t(`stt.engine.${group.engine}`)}</th>
                </tr>
                {group.items.map((model) => {
                  const dl = downloads[model.id];
                  const downloading = Boolean(dl?.active);
                  const deleting = Boolean(busyDelete[model.id]);
                  return (
                    <tr key={model.id} className="border-t border-[var(--border)] align-middle">
                      <td className="py-2.5 pr-3">
                        <span className="text-[var(--text)]">{model.label ?? model.id}</span>
                        {model.label && model.label !== model.id && (
                          <div className="mt-0.5 font-mono text-[10.5px] text-[var(--text-3)]">{model.id}</div>
                        )}
                        {model.cachePath && (
                          <div className="mt-0.5 break-all text-[10px] text-[var(--text-3)]">{model.cachePath}</div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-[var(--text-2)]">{formatMb(model.sizeMb)}</td>
                      <td className="py-2.5 pr-3 text-[var(--text-2)]">{formatMb(model.requiredRamMb)}</td>
                      <td className="py-2.5 pr-3 text-[var(--text-2)]">{formatMb(model.requiredVramMb)}</td>
                      <td className="py-2.5 pr-3"><ModelStatus model={model} /></td>
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
            ))}
          </table>
        </div>
      )}
    </div>
  );
}
