import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { Accordion, ActionButton, EmptyHint, ProgressSmall, SelectionBar, SettingsSection } from "../../ui/primitives";
import {
  useMutationWithInvalidation,
  useModelDownload,
  useSettingsQuery,
  useSSE,
  useTranscriptionHealthQuery,
  useTranscriptionHistoryQuery,
  useWhisperModelsQuery,
} from "../../hooks";
import type { ScannedFile, TranscriptionHistoryEntry, WhisperModel } from "../../types";
import { buildFolderTree } from "./folderTree";
import { filterLibraryFiles } from "./libraryFilter";
import type { SortBy, SortDir, TreeNode } from "./folderTree";
import { TranscriptionHistoryPanel } from "../dashboard/TranscriptionHistoryPanel";
import { str } from "../../lib/settings-value";

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;
const validSortBy = (value: unknown): SortBy => (value === "name" || value === "date" ? value : "date");
const validSortDir = (value: unknown): SortDir => (value === "asc" || value === "desc" ? value : "desc");

type OutputFormat = "srt" | "ass" | "vtt" | "txt";
const FORMATS: OutputFormat[] = ["srt", "ass", "vtt", "txt"];
const FALLBACK_MODELS = ["tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3", "distil-large-v3", "large-v3-turbo"];
const COMMON_LANGS = ["auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar", "hi"];
// CTranslate2 compute types are device-specific: float16 / int8_float16 are
// GPU-only and crash on CPU. Gate the selector by device so an invalid pair can
// never be chosen (keeps it simple + error-free). int8 is valid everywhere.
const COMPUTE_BY_DEVICE: Record<string, string[]> = {
  cpu: ["int8", "float32"],
  cuda: ["int8", "int8_float16", "float16", "float32"],
};

interface FileProgress { pct?: number; done?: boolean; error?: boolean; cancelled?: boolean; phase?: string }

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

  // History clearing only drops list entries — subtitle files on disk are kept,
  // and the server refuses to clear attempts that are still running.
  const clearHistoryMutation = useMutationWithInvalidation(() => api.clearTranscriptionHistory());
  const removeAttemptMutation = useMutationWithInvalidation((id: string) => api.deleteTranscriptionAttempt(id));
  const [removingId, setRemovingId] = useState<string | null>(null);

  const onClearHistory = async () => {
    const clearable = attempts.filter((attempt) => attempt.status !== "running").length;
    if (clearable === 0) return;
    const ok = await confirm({
      title: t("transcriptionHistory.clearTitle"),
      message: t("transcriptionHistory.clearConfirm", { count: clearable }),
      confirmLabel: t("transcriptionHistory.clear"),
    });
    if (!ok) return;
    try {
      const result = await clearHistoryMutation.mutateAsync();
      addToast(t("transcriptionHistory.cleared", { count: result.removed }), "success");
    } catch (e: unknown) {
      addToast(t("transcriptionHistory.clearFailed", { message: getErrorMessage(e) }), "error");
    }
    historyQuery.refetch();
  };

  // Retries run one after another: firing every failed file at once would stack
  // concurrent transcriptions on a backend that just demonstrated it is unhappy.
  const onRetryAllFailed = async (targets: TranscriptionHistoryEntry[]) => {
    let ok = 0;
    for (const target of targets) {
      try {
        await retryMutation.mutateAsync(target.id);
        ok += 1;
      } catch (e: unknown) {
        addToast(`${baseName(target.inputPath)}: ${getErrorMessage(e)}`, "error");
      }
    }
    addToast(t("transcriptionHistory.retriedAll", { ok, total: targets.length }), ok > 0 ? "success" : "error");
    historyQuery.refetch();
  };

  const onRemoveAttempt = async (attempt: TranscriptionHistoryEntry) => {
    setRemovingId(attempt.id);
    try {
      await removeAttemptMutation.mutateAsync(attempt.id);
    } catch (e: unknown) {
      addToast(t("transcriptionHistory.clearFailed", { message: getErrorMessage(e) }), "error");
    } finally {
      setRemovingId(null);
    }
    historyQuery.refetch();
  };

  // Whisper models list — used to check downloaded flag before running.
  // Only query when the backend is configured; the models endpoint proxies to
  // the whisper backend and will 502 if it's not reachable.
  const modelsQuery = useWhisperModelsQuery(backendConfigured && enabled);
  const whisperModels: WhisperModel[] = modelsQuery.data?.models ?? [];

  // Live download progress state + the downloadModel action.
  const { downloads: modelDownloads, downloadModel } = useModelDownload(() => { /* no external callback needed */ });

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

  // Sort controls: key (name or date) and direction. Re-sorting is memo-only —
  // no refetch needed. Defaults: newest files first.
  const [libraryQuery, setLibraryQuery] = useState("");
  const [hideWithSubtitles, setHideWithSubtitles] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Build a navigable folder tree from the file paths so subfolders can be
  // expanded and selected individually (not collapsed into one top-level group).
  // Filter before the tree is built so empty folders drop out with their files.
  const visibleFiles = useMemo(
    () => filterLibraryFiles(videoFiles, { query: libraryQuery, hideWithSubtitles }),
    [videoFiles, libraryQuery, hideWithSubtitles],
  );
  const isFiltered = visibleFiles.length !== videoFiles.length;
  // Selections survive a filter change (so narrowing the view does not silently
  // discard them), which means `selected` can hold paths that are no longer on
  // screen. Every action works from the intersection instead — transcribing a
  // file the user cannot see is worse than forgetting it was ticked. Mirrors how
  // ScanResultsPanel intersects its selection with the filtered file list.
  const visiblePaths = useMemo(
    () => new Set(visibleFiles.map((f) => f.videoPath as string)),
    [visibleFiles],
  );
  const tree = useMemo(() => buildFolderTree(visibleFiles, sortBy, sortDir), [visibleFiles, sortBy, sortDir]);

  // Per-run options (default from Settings + advertised capabilities).
  const [model, setModel] = useState("");
  const [device, setDevice] = useState("");
  const [computeType, setComputeType] = useState("");
  const [language, setLanguage] = useState("");
  const [format, setFormat] = useState("");
  // null = follow the saved default; true/false = explicit per-run override.
  const [diarize, setDiarize] = useState<boolean | null>(null);
  const [urlValue, setUrlValue] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  // Diarization toggle is offered only when the backend advertises it (pyannote
  // installed + HF token configured), so it can never be a silent no-op.
  const canDiarize = Boolean(caps?.advancedOptions?.speakerDiarization);
  // Default the toggle from the saved advanced_stt setting so a user who enabled
  // diarization in Settings doesn't get it silently dropped on every run.
  const sttDiarizationDefault = useMemo(() => {
    try { return Boolean(JSON.parse(str(settings.transcription_advanced_stt, "{}"))?.speaker_diarization); }
    catch { return false; }
  }, [settings.transcription_advanced_stt]);
  const effDiarize = diarize ?? sttDiarizationDefault;
  // URL/YouTube input offered only when the backend has yt-dlp installed.
  const canUrl = Boolean((caps as { urlInput?: boolean } | undefined)?.urlInput);
  const modelOptions = caps?.models?.length ? caps.models : FALLBACK_MODELS;
  const deviceOptions = caps?.devices?.length ? caps.devices : ["cpu"];
  const eff = (v: string, fallbackKey: string, fb: string) => v || str(settings[fallbackKey], fb);
  const effModel = eff(model, "transcription_model", "small");
  const effDevice = eff(device, "transcription_device", "cpu");
  const effLang = eff(language, "transcription_language", "auto");
  // Compute options follow the chosen device; the effective value is always a
  // member of that set (falls back to int8), so cpu+float16 can't be submitted.
  const computeOptions = COMPUTE_BY_DEVICE[effDevice] ?? ["int8"];
  const rawCompute = eff(computeType, "transcription_compute_type", "int8");
  const effCompute = computeOptions.includes(rawCompute) ? rawCompute : computeOptions[0];
  const rawFormat = eff(format, "transcription_output_format", "srt");
  const effFormat: OutputFormat = (FORMATS as string[]).includes(rawFormat) ? (rawFormat as OutputFormat) : "srt";

  // Whisper-section selectors are write-through: changing one updates local state
  // for instant UI and persists to settings so it survives a reload (these all
  // fall back to the saved setting via eff()).
  const persistSetting = useMutationWithInvalidation((patch: Record<string, string>) => api.saveSettings(patch));
  const saveSetting = useCallback((key: string, value: string) => { persistSetting.mutate({ [key]: value }); }, [persistSetting]);

  useEffect(() => {
    if (!settingsQuery.isSuccess) return;
    setSortBy(validSortBy(settings.transcription_sort_by));
    setSortDir(validSortDir(settings.transcription_sort_dir));
  }, [settings.transcription_sort_by, settings.transcription_sort_dir, settingsQuery.isSuccess]);

  const handleSortByChange = useCallback((value: SortBy) => {
    setSortBy(value);
    saveSetting("transcription_sort_by", value);
  }, [saveSetting]);

  const toggleSortDir = useCallback(() => {
    setSortDir((current) => {
      const next: SortDir = current === "asc" ? "desc" : "asc";
      saveSetting("transcription_sort_dir", next);
      return next;
    });
  }, [saveSetting]);

  // Look up downloaded status for a given model id from the cached models list.
  const isModelDownloaded = useCallback((modelId: string): boolean | undefined => {
    if (whisperModels.length === 0) return undefined; // list not loaded yet
    const entry = whisperModels.find((m) => m.id === modelId);
    if (!entry) return undefined; // model not in list
    return entry.downloaded;
  }, [whisperModels]);

  /**
   * Confirm-then-download for one model. Returns true only when the model ended
   * up downloaded. Shared by the picker and the pre-run gate so the confirm copy,
   * toasts and failure handling can't drift apart.
   */
  const confirmAndDownload = useCallback(async (modelId: string): Promise<boolean> => {
    const entry = whisperModels.find((m) => m.id === modelId);
    const size = entry?.sizeMb;
    const message = typeof size === "number" && size > 0
      ? t("whisper.modelNotDownloadedMessage", { model: modelId, size: `${Math.round(size)} MB` })
      : t("whisper.modelNotDownloadedMessageNoSize", { model: modelId });

    const ok = await confirm({
      title: t("whisper.modelNotDownloadedTitle"),
      message,
      confirmLabel: t("settings.models.download"),
    });
    if (!ok) return false;

    try {
      addToast(t("whisper.modelDownloading", { model: modelId }), "info");
      await downloadModel(modelId);
      addToast(t("whisper.modelDownloadDone", { model: modelId }), "success");
      return true;
    } catch (e: unknown) {
      addToast(t("whisper.modelDownloadFailed", { model: modelId, message: getErrorMessage(e) }), "error");
      return false;
    }
  }, [whisperModels, t, confirm, addToast, downloadModel]);

  /**
   * Prompts the user to confirm a model download, then runs it.
   * Returns true when the model is ready (either was already downloaded, or
   * download confirmed+completed). Returns false when the user declines or
   * the models list hasn't loaded yet.
   */
  const ensureModelDownloaded = useCallback(async (modelId: string): Promise<boolean> => {
    const downloaded = isModelDownloaded(modelId);

    // Models list not yet loaded — don't let an unknown state slip through.
    if (downloaded === undefined) {
      if (modelsQuery.isLoading) {
        addToast(t("whisper.modelsStillLoading"), "info");
      }
      return false;
    }

    if (downloaded === true) return true;

    // Guard: if already downloading, don't stack a second dialog.
    if (modelDownloads[modelId]?.active) {
      return false;
    }

    return confirmAndDownload(modelId);
  }, [isModelDownloaded, modelsQuery.isLoading, modelDownloads, addToast, t, confirmAndDownload]);

  // Handle model picker selection: if the chosen model is not downloaded,
  // prompt the user before committing the selection.
  const handleModelChange = useCallback(async (newModelId: string) => {
    const previousModel = model; // capture before any state change
    setModel(newModelId);

    if (isModelDownloaded(newModelId) === false) {
      // Guard: if already downloading this model, skip re-prompting.
      if (modelDownloads[newModelId]?.active) return;

      // Declining or a failed download both leave the model unusable — put the
      // picker back where it was rather than persisting a broken selection.
      if (!(await confirmAndDownload(newModelId))) {
        setModel(previousModel);
        return;
      }
    }
    saveSetting("transcription_model", newModelId);
  }, [model, isModelDownloaded, modelDownloads, confirmAndDownload, saveSetting]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedVisible = useMemo(
    () => Array.from(selected).filter((path) => visiblePaths.has(path)),
    [selected, visiblePaths],
  );

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgress>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const cancelRef = useRef(false);
  // Synchronous mirror of activePath so cancelBatch always targets the file the
  // loop is actually on (state can lag a render behind).
  const activePathRef = useRef<string | null>(null);

  // Default-expand the top-level folders when the tree (re)builds.
  useEffect(() => {
    setExpanded((prev) => (prev.size ? prev : new Set(tree.children.map((c) => c.path))));
  }, [tree]);
  const toggleExpand = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });

  // Drop stale selections when the library refetches (a file may be gone).
  useEffect(() => {
    const present = new Set(videoFiles.map((f) => f.videoPath as string));
    setSelected((prev) => {
      const next = new Set(Array.from(prev).filter((p) => present.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [videoFiles]);

  // Live per-file progress from the server's SSE broadcast. Stable callback so
  // useSSE's ref-sync effect doesn't churn every render.
  useSSE(useCallback((type, data) => {
    if (type !== "transcription:progress") return;
    const d = data as { path?: string; pct?: number; done?: boolean; error?: boolean; cancelled?: boolean; phase?: string };
    if (!d.path) return;
    // Merge so a phase-only line (e.g. "diarizing") keeps the last pct.
    setFileProgress((prev) => {
      const cur = prev[d.path as string] || {};
      return {
        ...prev,
        [d.path as string]: {
          ...cur,
          ...(d.pct !== undefined ? { pct: d.pct } : {}),
          ...(d.done !== undefined ? { done: d.done } : {}),
          ...(d.error !== undefined ? { error: d.error } : {}),
          ...(d.cancelled !== undefined ? { cancelled: d.cancelled } : {}),
          ...(d.phase !== undefined ? { phase: d.phase } : {}),
        },
      };
    });
  }, []));

  const toggle = (vp: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(vp)) next.delete(vp); else next.add(vp);
      return next;
    });
  const toggleFolder = (paths: string[]) => {
    const allSelected = paths.length > 0 && paths.every((p) => selected.has(p));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) paths.forEach((p) => next.delete(p));
      else paths.forEach((p) => next.add(p));
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(visibleFiles.map((f) => f.videoPath as string)));

  const cancelBatch = async () => {
    cancelRef.current = true;
    const target = activePathRef.current;
    if (target) {
      try { await api.cancelTranscription({ path: target }); } catch { /* best-effort */ }
    }
  };

  const transcribeSelected = async () => {
    const paths = selectedVisible;
    if (paths.length === 0) return;

    // Gate 1: check the selected model is downloaded before we start the batch.
    // On decline, cancel the run (leave model selected, do nothing else).
    const modelReady = await ensureModelDownloaded(effModel);
    if (!modelReady) return;

    const withSubs = visibleFiles.filter((f) => f.videoPath && paths.includes(f.videoPath) && f.subtitles.length > 0);
    if (withSubs.length > 0) {
      const ok = await confirm({
        title: t("whisper.overwriteTitle"),
        message: t("whisper.overwriteConfirm", { count: withSubs.length }),
      });
      if (!ok) return;
    }
    setRunning(true);
    cancelRef.current = false;
    setFileProgress({});  // drop stale badges from a previous run
    setProgress({ done: 0, total: paths.length });
    let ok = 0;
    for (let i = 0; i < paths.length; i++) {
      if (cancelRef.current) break;
      activePathRef.current = paths[i];
      setActivePath(paths[i]);
      try {
        await api.transcribeVideo({
          videoPath: paths[i],
          outputFormat: effFormat,
          postAction: "transcribe_only",
          model: effModel,
          language: effLang,
          device: effDevice,
          computeType: effCompute,
          speakerDiarization: canDiarize && effDiarize,
        });
        ok += 1;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : t("whisper.failedFallback");
        if (!/cancelled/i.test(msg)) addToast(`${baseName(paths[i])}: ${msg}`, "error");
      }
      setProgress({ done: i + 1, total: paths.length });
    }
    activePathRef.current = null;
    setActivePath(null);
    setRunning(false);
    setProgress(null);
    setSelected(new Set());
    addToast(t("whisper.batchDone", { ok, total: paths.length, format: effFormat.toUpperCase() }), ok > 0 ? "success" : "error");
    scanQuery.refetch();
    historyQuery.refetch();
  };

  const transcribeFromUrl = async () => {
    const url = urlValue.trim();
    if (!url) return;
    setUrlBusy(true);
    try {
      const res = await api.transcribeUrl({
        url, outputFormat: effFormat, model: effModel, language: effLang,
        device: effDevice, computeType: effCompute, speakerDiarization: canDiarize && effDiarize,
      });
      // No local media file for a URL — hand the rendered subtitle to the browser.
      const blob = new Blob([res.content], { type: "text/plain;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      const safeExt = (FORMATS as string[]).includes(res.outputFormat) ? res.outputFormat : effFormat;
      a.download = `transcript.${safeExt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      addToast(t("whisper.urlDone", { segments: res.segments ?? 0 }), "success");
      setUrlValue("");
    } catch (e: unknown) {
      addToast(`${t("whisper.urlFailed")}: ${e instanceof Error ? e.message : t("whisper.failedFallback")}`, "error");
    } finally {
      setUrlBusy(false);
    }
  };

  const selectCls = "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-[12px] text-[var(--text)]";
  const optionLabelCls = "flex flex-col gap-1 text-[11px] text-[var(--text-2)]";
  const downloadsActive = Object.values(modelDownloads).some((dl) => dl.active);

  return (
    <div className={`mx-auto w-full max-w-[1100px] space-y-4 ${isMobile ? "p-3 pb-24" : "p-5"}`}>
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">{t("whisper.title")}</h1>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">{t("whisper.subtitle")}</p>
      </div>

      {!enabled && (
        <div className="rounded-xl border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-4 py-3 text-[13px] text-[var(--yellow)]">
          <span aria-hidden="true">⚠ </span>{t("whisper.disabledNotice")} <Link to="/settings" className="underline">{t("whisper.openSettings")}</Link>
        </div>
      )}

      {/* Enabled but no backend URL saved: without this the whole picker is
          hidden with no explanation of why. */}
      {enabled && !backendConfigured && (
        <div className="rounded-xl border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-4 py-3 text-[13px] text-[var(--yellow)]">
          <span aria-hidden="true">⚠ </span>{t("whisper.backendNotConfigured")} <Link to="/settings" className="underline">{t("whisper.openSettings")}</Link>
        </div>
      )}

      {enabled && backendConfigured && (
        <>
          {/* ── 1. Run options ─────────────────────────────────────────────
              Everyday knobs stay visible; device/compute/diarize are expert
              settings and live behind the Advanced disclosure. */}
          <SettingsSection title={t("whisper.runOptions")} description={t("whisper.runOptionsHint")}>
            <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
              <label className={optionLabelCls}>{t("whisper.model")}
                <select
                  value={effModel}
                  onChange={(e) => { void handleModelChange(e.target.value); }}
                  className={selectCls}
                >
                  {modelOptions.map((m) => {
                    const info = whisperModels.find((wm) => wm.id === m);
                    const notDl = info && !info.downloaded;
                    // Spell out "not downloaded" — a bare glyph plus option
                    // colouring is unreliable across browsers and cryptic.
                    return <option key={m} value={m}>{m}{notDl ? ` — ${t("settings.models.notDownloaded")}` : ""}</option>;
                  })}
                </select>
                {/* Not-downloaded badge for the currently-selected model */}
                {isModelDownloaded(effModel) === false && modelDownloads[effModel]?.active !== true && (
                  <span className="text-[10px] text-[var(--yellow)]"><span aria-hidden="true">⚠ </span>{t("settings.models.notDownloaded")}</span>
                )}
              </label>
              <label className={optionLabelCls}>{t("whisper.language")}
                <select value={effLang} onChange={(e) => { setLanguage(e.target.value); saveSetting("transcription_language", e.target.value); }} className={selectCls}>
                  {COMMON_LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <label className={optionLabelCls}>{t("whisper.format")}
                <select value={effFormat} onChange={(e) => { setFormat(e.target.value); saveSetting("transcription_output_format", e.target.value); }} className={selectCls}>
                  {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
                </select>
              </label>
            </div>

            <Accordion title={t("whisper.advancedOptions")}>
              <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
                <label className={optionLabelCls}>{t("whisper.device")}
                  <select value={effDevice} onChange={(e) => {
                    const newDevice = e.target.value;
                    setDevice(newDevice);
                    // Clamp the current compute type into the valid set for the new device
                    // so the persisted setting never becomes invalid (e.g. cpu+float16).
                    const validComputes = COMPUTE_BY_DEVICE[newDevice] ?? ["int8"];
                    const currentCompute = computeType || str(settings.transcription_compute_type, "int8");
                    const clampedCompute = validComputes.includes(currentCompute) ? currentCompute : validComputes[0];
                    if (clampedCompute !== computeType) setComputeType(clampedCompute);
                    persistSetting.mutate({ transcription_device: newDevice, transcription_compute_type: clampedCompute });
                  }} className={selectCls}>
                    {deviceOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
                <label className={optionLabelCls}>{t("whisper.compute")}
                  <select value={effCompute} onChange={(e) => { setComputeType(e.target.value); saveSetting("transcription_compute_type", e.target.value); }} className={selectCls}>
                    {computeOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                {canDiarize ? (
                  <label className="flex items-center gap-2 self-end pb-2 text-[11px] text-[var(--text-2)]">
                    <input type="checkbox" checked={effDiarize} onChange={(e) => setDiarize(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
                    {t("whisper.diarize")}
                  </label>
                ) : (
                  // Render the disabled row even while capabilities are still
                  // loading, so the control doesn't flicker into existence.
                  <label
                    className="flex items-center gap-2 self-end pb-2 text-[11px] text-[var(--text-3)] opacity-60"
                    title={caps ? t("whisper.diarizeUnavailable") : t("common.loading")}
                  >
                    <input type="checkbox" disabled className="h-4 w-4" />
                    {t("whisper.diarize")}
                  </label>
                )}
              </div>
            </Accordion>

            {/* Model download progress — shown when a model is being downloaded */}
            {Object.entries(modelDownloads).filter(([, dl]) => dl.active).map(([modelId, dl]) => (
              <div key={modelId} className="flex items-center gap-3 rounded-lg border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-3 py-2">
                <span className="text-[11px] text-[var(--yellow)] shrink-0">{t("whisper.modelDownloading", { model: modelId })}</span>
                <div className="flex-1"><ProgressSmall pct={dl.pct} large /></div>
              </div>
            ))}
          </SettingsSection>

          {/* ── 2. Transcribe from URL (only when backend has yt-dlp) ────── */}
          {canUrl && (
            <SettingsSection title={t("whisper.urlTitle")} description={t("whisper.urlHint")}>
              <div className={`flex gap-2 ${isMobile ? "flex-col items-stretch" : "items-center"}`}>
                <input
                  type="url"
                  aria-label={t("whisper.urlPlaceholder")}
                  value={urlValue}
                  onChange={(e) => setUrlValue(e.target.value)}
                  placeholder={t("whisper.urlPlaceholder")}
                  className={`${selectCls} min-w-0 flex-1`}
                />
                <ActionButton
                  variant="primary"
                  size="sm"
                  onClick={() => { void transcribeFromUrl(); }}
                  disabled={!urlValue.trim()}
                  busy={urlBusy}
                  className={isMobile ? "w-full" : ""}
                >
                  {urlBusy ? t("whisper.urlBusy") : t("whisper.urlButton")}
                </ActionButton>
              </div>
            </SettingsSection>
          )}

          {/* ── 3. Library — the primary working surface ─────────────────── */}
          <SettingsSection title={t("whisper.pickerTitle")} description={t("whisper.pickerHint")}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={libraryQuery}
                onChange={(e) => setLibraryQuery(e.target.value)}
                placeholder={t("whisper.filterPlaceholder")}
                aria-label={t("whisper.filterPlaceholder")}
                className="min-w-[180px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12px] text-[var(--text)] placeholder:text-[var(--text-3)]"
              />
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
                <input
                  type="checkbox"
                  checked={hideWithSubtitles}
                  onChange={(e) => setHideWithSubtitles(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                {t("whisper.hideWithSubtitles")}
              </label>
              <select
                aria-label={t("whisper.sortAriaLabel")}
                value={sortBy}
                onChange={(e) => handleSortByChange(e.target.value as SortBy)}
                className={selectCls}
              >
                <option value="name">{t("whisper.sortByName")}</option>
                <option value="date">{t("whisper.sortByDate")}</option>
              </select>
              <ActionButton variant="ghost" size="sm" onClick={toggleSortDir}>
                <span aria-hidden="true">{sortDir === "asc" ? "↑" : "↓"}</span>
                <span className="sr-only">{sortDir === "asc" ? t("whisper.sortAsc") : t("whisper.sortDesc")}</span>
              </ActionButton>
              <ActionButton variant="ghost" size="sm" onClick={selectAll} disabled={running || visibleFiles.length === 0}>
                {t("whisper.selectAll")}
              </ActionButton>
              <ActionButton variant="ghost" size="sm" onClick={() => { void scanQuery.refetch(); }} disabled={scanQuery.isFetching} className="ml-auto">
                {scanQuery.isFetching
                  ? <><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" aria-hidden="true" />{t("whisper.scanning")}</>
                  : <><span aria-hidden="true">↻</span> {t("whisper.refresh")}</>
                }
              </ActionButton>
            </div>

            {isFiltered && (
              <div className="text-[11px] text-[var(--text-3)]">
                {t("whisper.filteredCount", { shown: visibleFiles.length, total: videoFiles.length })}
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {/* Run actions appear against a selection, matching the pattern
                  ScanResultsPanel uses for the sibling scan flow. */}
              <SelectionBar
                count={selectedVisible.length}
                isMobile={isMobile}
                summaryLabel={t("whisper.selectedSummary", { count: selectedVisible.length })}
                hintLabel={t("whisper.overwriteHint")}
                clearLabel={t("whisper.clear")}
                onClear={() => setSelected(new Set())}
              >
                <ActionButton
                  variant="primary"
                  size="sm"
                  onClick={() => { void transcribeSelected(); }}
                  disabled={running || downloadsActive}
                  busy={running}
                >
                  {running && progress
                    ? t("whisper.transcribingProgress", { done: progress.done, total: progress.total })
                    : t("whisper.transcribeSelected", { count: selectedVisible.length })}
                </ActionButton>
                {running && (
                  <ActionButton variant="danger" size="sm" onClick={() => { void cancelBatch(); }}>
                    {t("whisper.cancel")}
                  </ActionButton>
                )}
              </SelectionBar>

              <div className="max-h-[45vh] overflow-y-auto">
                {scanQuery.isLoading && <EmptyHint text={t("whisper.scanning")} />}
                {!scanQuery.isLoading && videoFiles.length === 0 && <EmptyHint text={t("whisper.noVideos")} />}
                {!scanQuery.isLoading && videoFiles.length > 0 && visibleFiles.length === 0 && (
                  <EmptyHint text={t("whisper.noMatchingVideos")} />
                )}
                {!scanQuery.isLoading && tree.children.map((child) => (
                  <FolderNodeView
                    key={child.path}
                    node={child}
                    depth={0}
                    selected={selected}
                    expanded={expanded}
                    toggleExpand={toggleExpand}
                    toggleFolder={toggleFolder}
                    toggleFile={toggle}
                    fileProgress={fileProgress}
                    activePath={activePath}
                    running={running}
                  />
                ))}
                {/* Files directly in the media root (no subfolder). */}
                {!scanQuery.isLoading && tree.files.map((f) => (
                  <FileRow key={f.videoPath as string} file={f} depth={0} selected={selected} toggleFile={toggle} fileProgress={fileProgress} activePath={activePath} running={running} />
                ))}
              </div>
            </div>

            <span aria-live="polite" className="sr-only">
              {running && progress ? t("whisper.transcribingProgress", { done: progress.done, total: progress.total }) : ""}
            </span>
          </SettingsSection>
        </>
      )}

      {/* Readiness + Model Manager live in Settings → Speech to Text; the Whisper
          page focuses on picking files and transcribing. */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
        <TranscriptionHistoryPanel
          attempts={attempts}
          transcribingPath={activePath}
          isRetryPending={retryMutation.isPending}
          isTranscribePending={running}
          onRetry={onRetry}
          onClear={onClearHistory}
          onRemove={onRemoveAttempt}
          onRetryAllFailed={onRetryAllFailed}
          isClearPending={clearHistoryMutation.isPending}
          removingId={removingId}
        />
      </section>
    </div>
  );
}

interface FileRowProps {
  file: ScannedFile;
  depth: number;
  selected: Set<string>;
  toggleFile: (vp: string) => void;
  fileProgress: Record<string, FileProgress>;
  activePath: string | null;
  running: boolean;
}

function FileRow({ file, depth, selected, toggleFile, fileProgress, activePath, running }: FileRowProps) {
  const { t } = useTranslation();
  const vp = file.videoPath as string;
  const fp = fileProgress[vp];
  const isActive = activePath === vp;
  const status = fp?.done ? t("whisper.statusDone")
    : fp?.cancelled ? t("whisper.statusCancelled")
    : fp?.error ? t("whisper.statusError")
    : fp?.phase === "diarizing" ? t("whisper.diarizing")
    : typeof fp?.pct === "number" ? `${Math.round(fp.pct)}%` : "";
  return (
    <label className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
      style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}>
      {/* Selection is frozen mid-batch: the run works from the list captured at
          start, so letting it change would misrepresent what is queued. */}
      <input type="checkbox" checked={selected.has(vp)} disabled={running} onChange={() => toggleFile(vp)} className="h-4 w-4 accent-[var(--accent)]" />
      <span className="truncate"><span aria-hidden="true">🎬</span> {file.videoName || baseName(vp)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {status && (
          // The running file is marked with a glyph + weight, not accent colour
          // alone, and announced so it isn't a purely visual distinction.
          <span className={`text-[10px] ${isActive ? "font-semibold text-[var(--accent)]" : "text-[var(--text-3)]"}`}>
            {isActive && <span aria-hidden="true">▶ </span>}
            {isActive && <span className="sr-only">{t("whisper.transcribingNow")} </span>}
            {status}
          </span>
        )}
        {file.subtitles.length > 0 && <span className="text-[10px] text-[var(--text-3)]">{t("whisper.hasSubtitle")}</span>}
      </span>
    </label>
  );
}

interface FolderNodeProps {
  node: TreeNode;
  depth: number;
  selected: Set<string>;
  expanded: Set<string>;
  toggleExpand: (p: string) => void;
  toggleFolder: (paths: string[]) => void;
  toggleFile: (vp: string) => void;
  fileProgress: Record<string, FileProgress>;
  activePath: string | null;
  running: boolean;
}

function FolderNodeView(props: FolderNodeProps) {
  const { t } = useTranslation();
  const { node, depth, selected, expanded, toggleExpand, toggleFolder, running } = props;
  const open = expanded.has(node.path);
  const allSel = node.allPaths.length > 0 && node.allPaths.every((p) => selected.has(p));
  const someSel = !allSel && node.allPaths.some((p) => selected.has(p));
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] font-medium text-[var(--text)]"
        style={{ paddingLeft: `${12 + depth * 16}px` }}>
        {/* The caret, the checkbox and the name button are three distinct
            controls; each needs a name describing its own action, or a screen
            reader just hears the folder name three times in a row. */}
        <button type="button" onClick={() => toggleExpand(node.path)} className="w-3 shrink-0 text-[var(--text-3)]" aria-label={t("whisper.toggleFolder", { name: node.name })} aria-expanded={open}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        <input
          type="checkbox"
          aria-label={t("whisper.selectFolder", { name: node.name })}
          checked={allSel}
          disabled={running}
          ref={(el) => { if (el) el.indeterminate = someSel; }}
          onChange={() => toggleFolder(node.allPaths)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        <button type="button" onClick={() => toggleExpand(node.path)} aria-label={t("whisper.toggleFolder", { name: node.name })} aria-expanded={open} className="flex-1 truncate text-left">
          <span aria-hidden="true">📁</span> {node.name} <span className="text-[10px] text-[var(--text-3)]">({node.allPaths.length})</span>
        </button>
      </div>
      {open && (
        <>
          {node.children.map((c) => <FolderNodeView key={c.path} {...props} node={c} depth={depth + 1} />)}
          {node.files.map((f) => (
            <FileRow key={f.videoPath as string} file={f} depth={depth} selected={selected} toggleFile={props.toggleFile} fileProgress={props.fileProgress} activePath={props.activePath} running={running} />
          ))}
        </>
      )}
    </div>
  );
}
