import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as api from "../../api";
import { useToast } from "../../components/Toast";
import {
  useMutationWithInvalidation,
  useSettingsQuery,
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

/**
 * Whisper / speech-to-text hub. Browse the server media library, pick single
 * files / multiple files / whole folders, choose an output format (srt/ass/
 * vtt/txt), and transcribe them — separate from the translation flow. Also
 * surfaces backend readiness, the model manager, and recent history.
 */
export function WhisperPage({ isMobile = false }: { isMobile?: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const settingsQuery = useSettingsQuery();
  const settings = (settingsQuery.data ?? {}) as Record<string, unknown>;
  const backendConfigured = Boolean(str(settings.transcription_backend_url));
  const enabled = str(settings.transcription_enabled, "0") === "1";

  const healthQuery = useTranscriptionHealthQuery(backendConfigured);
  const historyQuery = useTranscriptionHistoryQuery(true, 20);
  const attempts = historyQuery.data?.attempts ?? [];

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

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<OutputFormat>("srt");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

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

  const transcribeSelected = async () => {
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    setRunning(true);
    setProgress({ done: 0, total: paths.length });
    let ok = 0;
    for (let i = 0; i < paths.length; i++) {
      try {
        await api.transcribeVideo({ videoPath: paths[i], outputFormat: format, postAction: "transcribe_only" });
        ok += 1;
      } catch (e: unknown) {
        addToast(`${baseName(paths[i])}: ${e instanceof Error ? e.message : "failed"}`, "error");
      }
      setProgress({ done: i + 1, total: paths.length });
    }
    setRunning(false);
    setProgress(null);
    setSelected(new Set());
    addToast(t("whisper.batchDone", { ok, total: paths.length, format: format.toUpperCase() }), ok > 0 ? "success" : "error");
    scanQuery.refetch();
    historyQuery.refetch();
  };

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

      {/* ── File / folder picker ── */}
      {enabled && backendConfigured && (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[13.5px] font-semibold text-[var(--text)]">{t("whisper.pickerTitle")}</h2>
              <p className="text-[11px] text-[var(--text-3)]">{t("whisper.pickerHint")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[11px] text-[var(--text-2)]">{t("whisper.format")}</label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as OutputFormat)}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] text-[var(--text)]"
                aria-label={t("whisper.format")}
              >
                {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
              <button
                type="button"
                disabled={running || selected.size === 0}
                onClick={transcribeSelected}
                className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
              >
                {running && progress
                  ? t("whisper.transcribingProgress", { done: progress.done, total: progress.total })
                  : t("whisper.transcribeSelected", { count: selected.size })}
              </button>
              <button
                type="button"
                onClick={() => scanQuery.refetch()}
                disabled={scanQuery.isFetching}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-2)]"
              >
                {scanQuery.isFetching ? t("whisper.scanning") : t("whisper.rescan")}
              </button>
            </div>
          </div>

          <div className="mt-3 max-h-[44vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
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
                    <input
                      type="checkbox"
                      checked={allSel}
                      ref={(el) => { if (el) el.indeterminate = someSel; }}
                      onChange={() => toggleFolder(files)}
                      className="h-4 w-4 accent-blue-500"
                    />
                    📁 {group} <span className="text-[10px] text-[var(--text-3)]">({files.length})</span>
                  </label>
                  {files.map((f) => {
                    const vp = f.videoPath as string;
                    const hasSubs = f.subtitles.length > 0;
                    return (
                      <label key={vp} className="flex items-center gap-2 px-3 py-1.5 pl-7 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]">
                        <input type="checkbox" checked={selected.has(vp)} onChange={() => toggle(vp)} className="h-4 w-4 accent-blue-500" />
                        <span className="truncate">🎬 {f.videoName || baseName(vp)}</span>
                        {hasSubs && <span className="ml-auto shrink-0 text-[10px] text-[var(--text-3)]">{t("whisper.hasSubtitle")}</span>}
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
        <TranscriptionHistoryPanel
          attempts={attempts}
          transcribingPath={null}
          isRetryPending={retryMutation.isPending}
          isTranscribePending={running}
          onRetry={onRetry}
        />
      </section>
    </div>
  );
}
