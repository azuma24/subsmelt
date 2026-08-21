import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
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
import type { SortBy, SortDir } from "./folderTree";
import { collectFolderPaths } from "../../components/file-tree/build";
import { usePersistedExpansion } from "../../components/file-tree/use-persisted-expansion";
import { useDrillDown } from "../../components/file-tree/use-drill-down";
import { TranscriptionHistoryPanel } from "../dashboard/TranscriptionHistoryPanel";
import { str } from "../../lib/settings-value";
import { useModelGate } from "./useModelGate";
import { RunOptionsSection } from "./RunOptionsSection";
import { UrlTranscribeSection } from "./UrlTranscribeSection";
import { LibraryPicker } from "./LibraryPicker";
import { baseName, COMPUTE_BY_DEVICE, FALLBACK_MODELS, FORMATS, type FileProgress, type OutputFormat } from "./whisper-shared";

const validSortBy = (value: unknown): SortBy => (value === "name" || value === "date" ? value : "date");
const validSortDir = (value: unknown): SortDir => (value === "asc" || value === "desc" ? value : "desc");

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

  // Model download/confirm gate — see useModelGate for the isModelDownloaded /
  // confirmAndDownload / ensureModelDownloaded / handleModelChange logic.
  const { isModelDownloaded, ensureModelDownloaded, handleModelChange } = useModelGate({
    whisperModels, modelsQuery, modelDownloads, downloadModel, model, setModel, saveSetting, confirm, addToast, t,
  });

  // Run-options change handlers: write-through to local state + persisted setting.
  const handleLanguageChange = useCallback((value: string) => {
    setLanguage(value);
    saveSetting("transcription_language", value);
  }, [saveSetting]);

  const handleFormatChange = useCallback((value: string) => {
    setFormat(value);
    saveSetting("transcription_output_format", value);
  }, [saveSetting]);

  const handleDeviceChange = useCallback((newDevice: string) => {
    setDevice(newDevice);
    // Clamp the current compute type into the valid set for the new device
    // so the persisted setting never becomes invalid (e.g. cpu+float16).
    const validComputes = COMPUTE_BY_DEVICE[newDevice] ?? ["int8"];
    const currentCompute = computeType || str(settings.transcription_compute_type, "int8");
    const clampedCompute = validComputes.includes(currentCompute) ? currentCompute : validComputes[0];
    if (clampedCompute !== computeType) setComputeType(clampedCompute);
    persistSetting.mutate({ transcription_device: newDevice, transcription_compute_type: clampedCompute });
  }, [computeType, settings.transcription_compute_type, persistSetting]);

  const handleComputeChange = useCallback((value: string) => {
    setComputeType(value);
    saveSetting("transcription_compute_type", value);
  }, [saveSetting]);

  const handleDiarizeChange = useCallback((checked: boolean) => {
    setDiarize(checked);
  }, []);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedVisible = useMemo(
    () => Array.from(selected).filter((path) => visiblePaths.has(path)),
    [selected, visiblePaths],
  );

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgress>>({});
  const cancelRef = useRef(false);
  // Synchronous mirror of activePath so cancelBatch always targets the file the
  // loop is actually on (state can lag a render behind).
  const activePathRef = useRef<string | null>(null);

  // Expand/collapse is persisted per folder in localStorage (default collapsed)
  // and pruned against the folders present after each scan. Prune against the
  // unfiltered tree so narrowing the filter can't silently discard state.
  const fullTree = useMemo(() => buildFolderTree(videoFiles, sortBy, sortDir), [videoFiles, sortBy, sortDir]);
  const folderPaths = useMemo(() => collectFolderPaths(fullTree.children), [fullTree]);
  const expansion = usePersistedExpansion("whisper", folderPaths);
  // Text filter switches to a flat list, so the tree (and drill-down) only
  // drives the unfiltered / subtitle-toggle views.
  const filterActive = libraryQuery.trim().length > 0;
  const drill = useDrillDown(tree.children, isMobile && !filterActive);

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

  const downloadsActive = Object.values(modelDownloads).some((dl) => dl.active);

  return (
    // Same page chrome as the Converter: sticky title bar + scrolling body, so
    // switching between sibling pages doesn't change the header pattern.
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-30 shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 md:px-[18px]">
        <div className="flex min-h-[42px] items-center gap-2.5">
          <h1 className="text-sm font-semibold text-[var(--text)]">{t("whisper.title")}</h1>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <div className={`mx-auto w-full max-w-[1100px] space-y-4 ${isMobile ? "p-3 pb-24" : "p-5"}`}>
          <p className="text-[13px] text-[var(--text-2)]">{t("whisper.subtitle")}</p>

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
          <RunOptionsSection
            isMobile={isMobile}
            modelOptions={modelOptions}
            whisperModels={whisperModels}
            effModel={effModel}
            onModelChange={handleModelChange}
            isModelDownloaded={isModelDownloaded}
            modelDownloads={modelDownloads}
            effLang={effLang}
            onLanguageChange={handleLanguageChange}
            effFormat={effFormat}
            onFormatChange={handleFormatChange}
            effDevice={effDevice}
            onDeviceChange={handleDeviceChange}
            deviceOptions={deviceOptions}
            effCompute={effCompute}
            onComputeChange={handleComputeChange}
            computeOptions={computeOptions}
            canDiarize={canDiarize}
            effDiarize={effDiarize}
            onDiarizeChange={handleDiarizeChange}
            hasCaps={Boolean(caps)}
          />

          {/* ── 2. Transcribe from URL (only when backend has yt-dlp) ────── */}
          {canUrl && (
            <UrlTranscribeSection
              isMobile={isMobile}
              effFormat={effFormat}
              effModel={effModel}
              effLang={effLang}
              effDevice={effDevice}
              effCompute={effCompute}
              canDiarize={canDiarize}
              effDiarize={effDiarize}
            />
          )}

          {/* ── 3. Library — the primary working surface ─────────────────── */}
          <LibraryPicker
            isMobile={isMobile}
            libraryQuery={libraryQuery}
            onLibraryQueryChange={setLibraryQuery}
            hideWithSubtitles={hideWithSubtitles}
            onHideWithSubtitlesChange={setHideWithSubtitles}
            sortBy={sortBy}
            onSortByChange={handleSortByChange}
            sortDir={sortDir}
            onToggleSortDir={toggleSortDir}
            onSelectAll={selectAll}
            running={running}
            visibleFiles={visibleFiles}
            videoFiles={videoFiles}
            isFiltered={isFiltered}
            isScanFetching={scanQuery.isFetching}
            isScanLoading={scanQuery.isLoading}
            onRefreshScan={scanQuery.refetch}
            selectedVisibleCount={selectedVisible.length}
            onClearSelection={() => setSelected(new Set())}
            onTranscribeSelected={transcribeSelected}
            downloadsActive={downloadsActive}
            progress={progress}
            onCancelBatch={cancelBatch}
            filterActive={filterActive}
            tree={tree}
            selected={selected}
            toggleFile={toggle}
            toggleFolder={toggleFolder}
            fileProgress={fileProgress}
            activePath={activePath}
            expansion={expansion}
            drill={drill}
          />
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
      </div>
    </div>
  );
}
