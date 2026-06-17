import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as api from "../../api";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import {
  useMutationWithInvalidation,
  useSettingsQuery,
  useSSE,
  useTranscriptionHealthQuery,
  useTranscriptionHistoryQuery,
} from "../../hooks";
import type { ScannedFile, TranscriptionHistoryEntry } from "../../types";
import { TranscriptionReadinessPanel } from "../settings/TranscriptionReadinessPanel";
import { ModelManagerPanel } from "../settings/ModelManagerPanel";
import { TranscriptionHistoryPanel } from "../dashboard/TranscriptionHistoryPanel";
import { getScanGroupName } from "../dashboard/ScanResultsPanel";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

type OutputFormat = "srt" | "ass" | "vtt" | "txt";
const FORMATS: OutputFormat[] = ["srt", "ass", "vtt", "txt"];
const FALLBACK_MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"];
const COMMON_LANGS = ["auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar", "hi"];

interface FileProgress { pct?: number; done?: boolean; error?: boolean; cancelled?: boolean }

export function WhisperPage({ isMobile = false }: { isMobile?: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const settingsQuery = useSettingsQuery();
  const settings = (settingsQuery.data ?? {}) as Record<string, unknown>;
  const backendConfigured = Boolean(str(settings.transcription_backend_url));
  const enabled = str(settings.transcription_enabled, "0") === "1";

  const healthQuery = useTranscriptionHealthQuery(backendConfigured);
  const historyQuery = useTranscriptionHistoryQuery(true, 20);
  const attempts = historyQuery.data?.attempts ?? [];
  const caps = healthQuery.data?.health?.capabilities;

  const retryMutation = useMutationWithInvalidation((id: string) => api.retryTranscriptionAttempt(id));
  const onRetry = (attempt: TranscriptionHistoryEntry) => retryMutation.mutate(attempt.id);

  // Library file list (non-mutating preview scan of MEDIA_DIR).
  const scanQuery = useQuery({
    queryKey: ["whisper-library"],
    queryFn: ({ signal }) => api.previewScan({ signal }),
    enabled: enabled && backendConfigured,
  });
  const videoFiles: ScannedFile[] = useMemo(
    () => (scanQuery.data?.files ?? []).filter((f) => Boolean(f.videoPath)),
    [scanQuery.data],
  );
  const groups = useMemo(() => {
    const g = new Map<string, ScannedFile[]>();
    for (const f of videoFiles) {
      const name = getScanGroupName(f);
      g.set(name, [...(g.get(name) || []), f]);
    }
    return Array.from(g.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [videoFiles]);

  // Per-run options (default from Settings + advertised capabilities).
  const [model, setModel] = useState("");
  const [device, setDevice] = useState("");
  const [computeType, setComputeType] = useState("");
  const [language, setLanguage] = useState("");
  const [format, setFormat] = useState<OutputFormat>("srt");
  const modelOptions = caps?.models?.length ? caps.models : FALLBACK_MODELS;
  const deviceOptions = caps?.devices?.length ? caps.devices : ["cpu"];
  const computeOptions = caps?.computeTypes?.length ? caps.computeTypes : ["int8"];
  const eff = (v: string, fallbackKey: string, fb: string) => v || str(settings[fallbackKey], fb);
  const effModel = eff(model, "transcription_model", "small");
  const effDevice = eff(device, "transcription_device", "cpu");
  const effCompute = eff(computeType, "transcription_compute_type", "int8");
  const effLang = eff(language, "transcription_language", "auto");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgress>>({});
  const cancelRef = useRef(false);

  // Drop stale selections when the library refetches (a file may be gone).
  useEffect(() => {
    const present = new Set(videoFiles.map((f) => f.videoPath as string));
    setSelected((prev) => {
      const next = new Set(Array.from(prev).filter((p) => present.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [videoFiles]);

  // Live per-file progress from the server's SSE broadcast.
  useSSE((type, data) => {
    if (type !== "transcription:progress") return;
    const d = data as { path?: string; pct?: number; done?: boolean; error?: boolean; cancelled?: boolean };
    if (!d.path) return;
    setFileProgress((prev) => ({ ...prev, [d.path as string]: { pct: d.pct, done: d.done, error: d.error, cancelled: d.cancelled } }));
  });

  const toggle = (vp: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(vp)) next.delete(vp); else next.add(vp);
      return next;
    });
  const toggleFolder = (files: ScannedFile[]) => {
    const paths = files.map((f) => f.videoPath as string);
    const allSelected = paths.every((p) => selected.has(p));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) paths.forEach((p) => next.delete(p));
      else paths.forEach((p) => next.add(p));
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(videoFiles.map((f) => f.videoPath as string)));

  const cancelBatch = async () => {
    cancelRef.current = true;
    if (activePath) {
      try { await api.cancelTranscription({ path: activePath }); } catch { /* best-effort */ }
    }
  };

  const transcribeSelected = async () => {
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    const withSubs = videoFiles.filter((f) => f.videoPath && selected.has(f.videoPath) && f.subtitles.length > 0);
    if (withSubs.length > 0) {
      const ok = await confirm({
        title: t("whisper.overwriteTitle"),
        message: t("whisper.overwriteConfirm", { count: withSubs.length }),
      });
      if (!ok) return;
    }
    setRunning(true);
    cancelRef.current = false;
    setProgress({ done: 0, total: paths.length });
    let ok = 0;
    for (let i = 0; i < paths.length; i++) {
      if (cancelRef.current) break;
      setActivePath(paths[i]);
      try {
        await api.transcribeVideo({
          videoPath: paths[i],
          outputFormat: format,
          postAction: "transcribe_only",
          model: effModel,
          language: effLang,
          device: effDevice,
          computeType: effCompute,
        });
        ok += 1;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "failed";
        if (!/cancelled/i.test(msg)) addToast(`${baseName(paths[i])}: ${msg}`, "error");
      }
      setProgress({ done: i + 1, total: paths.length });
    }
    setActivePath(null);
    setRunning(false);
    setProgress(null);
    setSelected(new Set());
    addToast(t("whisper.batchDone", { ok, total: paths.length, format: format.toUpperCase() }), ok > 0 ? "success" : "error");
    scanQuery.refetch();
    historyQuery.refetch();
  };

  const selectCls = "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] text-[var(--text)]";

  return (
    <div className={`mx-auto w-full max-w-[1100px] space-y-4 ${isMobile ? "p-3 pb-24" : "p-5"}`}>
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">{t("whisper.title")}</h1>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">{t("whisper.subtitle")}</p>
      </div>

      {!enabled && (
        <div className="rounded-2xl border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-4 py-3 text-[13px] text-[var(--yellow)]">
          {t("whisper.disabledNotice")} <Link to="/settings" className="underline">{t("whisper.openSettings")}</Link>
        </div>
      )}

      {enabled && backendConfigured && (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
          <div>
            <h2 className="text-[13.5px] font-semibold text-[var(--text)]">{t("whisper.pickerTitle")}</h2>
            <p className="text-[11px] text-[var(--text-3)]">{t("whisper.pickerHint")}</p>
          </div>

          {/* Per-run options */}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.model")}
              <select value={effModel} onChange={(e) => setModel(e.target.value)} className={selectCls}>
                {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.device")}
              <select value={effDevice} onChange={(e) => setDevice(e.target.value)} className={selectCls}>
                {deviceOptions.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.compute")}
              <select value={effCompute} onChange={(e) => setComputeType(e.target.value)} className={selectCls}>
                {computeOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.language")}
              <select value={effLang} onChange={(e) => setLanguage(e.target.value)} className={selectCls}>
                {COMMON_LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-2)]">{t("whisper.format")}
              <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)} className={selectCls}>
                {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </label>
          </div>

          {/* Actions */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={running || selected.size === 0} onClick={transcribeSelected}
              className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
              {running && progress ? t("whisper.transcribingProgress", { done: progress.done, total: progress.total }) : t("whisper.transcribeSelected", { count: selected.size })}
            </button>
            {running && (
              <button type="button" onClick={cancelBatch}
                className="rounded-lg border border-red-700/60 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-300">
                {t("whisper.cancel")}
              </button>
            )}
            <button type="button" onClick={selectAll} disabled={running || videoFiles.length === 0}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)] disabled:opacity-40">
              {t("whisper.selectAll")}
            </button>
            <button type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)] disabled:opacity-40">
              {t("whisper.clear")}
            </button>
            <button type="button" onClick={() => scanQuery.refetch()} disabled={scanQuery.isFetching}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)]">
              {scanQuery.isFetching ? t("whisper.scanning") : t("whisper.rescan")}
            </button>
          </div>

          <div className="mt-3 max-h-[40vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {scanQuery.isLoading && <div className="px-4 py-6 text-center text-xs text-[var(--text-3)]">{t("whisper.scanning")}</div>}
            {!scanQuery.isLoading && videoFiles.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-[var(--text-3)]">{t("whisper.noVideos")}</div>
            )}
            {groups.map(([group, files]) => {
              const paths = files.map((f) => f.videoPath as string);
              const allSel = paths.every((p) => selected.has(p));
              const someSel = !allSel && paths.some((p) => selected.has(p));
              return (
                <div key={group} className="border-b border-[var(--border)] last:border-b-0">
                  <label className="flex items-center gap-2 bg-[var(--surface-2)] px-3 py-2 text-[12px] font-medium text-[var(--text)]">
                    <input type="checkbox" checked={allSel} ref={(el) => { if (el) el.indeterminate = someSel; }} onChange={() => toggleFolder(files)} className="h-4 w-4 accent-blue-500" />
                    📁 {group} <span className="text-[10px] text-[var(--text-3)]">({files.length})</span>
                  </label>
                  {files.map((f) => {
                    const vp = f.videoPath as string;
                    const fp = fileProgress[vp];
                    const status = fp?.done ? t("whisper.statusDone") : fp?.cancelled ? t("whisper.statusCancelled") : fp?.error ? t("whisper.statusError") : typeof fp?.pct === "number" ? `${Math.round(fp.pct)}%` : "";
                    return (
                      <label key={vp} className="flex items-center gap-2 px-3 py-1.5 pl-7 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]">
                        <input type="checkbox" checked={selected.has(vp)} onChange={() => toggle(vp)} className="h-4 w-4 accent-blue-500" />
                        <span className="truncate">🎬 {f.videoName || baseName(vp)}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-2">
                          {status && <span className={`text-[10px] ${activePath === vp ? "text-[var(--accent)]" : "text-[var(--text-3)]"}`}>{status}</span>}
                          {f.subtitles.length > 0 && <span className="text-[10px] text-[var(--text-3)]">{t("whisper.hasSubtitle")}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-[var(--text-3)]">{t("whisper.overwriteHint")}</p>
        </section>
      )}

      <TranscriptionReadinessPanel settings={settings} healthQuery={healthQuery} dirty={false} />
      <ModelManagerPanel enabled={backendConfigured} />
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
        <TranscriptionHistoryPanel attempts={attempts} transcribingPath={activePath} isRetryPending={retryMutation.isPending} isTranscribePending={running} onRetry={onRetry} />
      </section>
    </div>
  );
}
