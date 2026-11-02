import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import { Link } from "react-router-dom";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useToast } from "../../ui/Toast";
import { useConfirm } from "../../ui/ConfirmModal";
import {
  LIBRARY_QUERY_KEY,
  useLibraryQuery,
  useMutationWithInvalidation,
  useModelDownload,
  useSettingsQuery,
  useSSE,
  useTranscriptionHealthQuery,
  useTranscriptionHistoryQuery,
  useWhisperModelsQuery,
  useIsMobile,
} from "../../hooks";
import type { ScannedFile, TranscriptionHistoryEntry, WhisperModel } from "../../types";
import { buildFolderTree } from "./folderTree";
import { filterLibraryFiles } from "./libraryFilter";
import type { SortBy, SortDir } from "./folderTree";
import { collectFolderPaths } from "../../ui/file-tree/build";
import { usePersistedExpansion } from "../../ui/file-tree/use-persisted-expansion";
import { useDrillDown } from "../../ui/file-tree/use-drill-down";
import { TranscriptionHistoryPanel } from "../dashboard/TranscriptionHistoryPanel";
import { str } from "../../lib/settings-value";
import { useModelGate } from "./useModelGate";
import { RunOptionsSection } from "./RunOptionsSection";
import { AutoTranscriptionControl } from "./AutoTranscriptionControl";
import { UrlTranscribeSection } from "./UrlTranscribeSection";
import { LibraryPicker } from "./LibraryPicker";
import { InlineError } from "../../ui/QueryState";

import { COMPUTE_BY_DEVICE, descriptorsFrom, FORMATS, type OutputFormat, transcriptionHost } from "./whisper-shared";
import { PageHeader } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { cancellableBatchIds } from "./work-batch.js";

const validSortBy = (value: unknown): SortBy => (value === "name" || value === "date" ? value : "date");
const validSortDir = (value: unknown): SortDir => (value === "asc" || value === "desc" ? value : "desc");

export function WhisperPage() {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const settingsQuery = useSettingsQuery();
  const settings = (settingsQuery.data ?? {}) as Record<string, unknown>;
  const workQuery = useQuery({
    queryKey: ["transcription-work"],
    queryFn: () => api.listTranscriptionWork(),
    refetchInterval: 1500,
  });
  const work = workQuery.data?.items ?? [];
  const backendConfigured = Boolean(str(settings.transcription_backend_url));
  const enabled = str(settings.transcription_enabled, "0") === "1";
  const mediaDir = str(settings._media_dir, "/media");

  const healthQuery = useTranscriptionHealthQuery(backendConfigured);
  const historyQuery = useTranscriptionHistoryQuery(true, 20);
  const attempts = historyQuery.data?.attempts ?? [];
  const caps = healthQuery.data?.health?.capabilities;

  // One retry at a time: the panel disables Retry while this is set, so a
  // second click cannot start an overlapping run of the same file.
  const [retryingPath, setRetryingPath] = useState<string | null>(null);
  const onRetry = async (attempt: TranscriptionHistoryEntry) => {
    if (retryingPath) return;
    setRetryingPath(attempt.inputPath);
    try {
      await api.queueTranscriptionWork([
        {
          kind: "file",
          input: attempt.inputPath,
          request: {
            postAction: attempt.postAction,
            outputFormat: attempt.outputFormat,
            model: attempt.model,
            language: attempt.language,
            device: attempt.device,
            computeType: attempt.computeType,
            advancedOptions: attempt.advancedOptions,
            overwrite: attempt.overwrite === true,
          },
        },
      ]);
      void workQuery.refetch();
    } catch (e: unknown) {
      addToast(t("transcriptionHistory.retryFailed", { message: getErrorMessage(e) }), "error");
    } finally {
      setRetryingPath(null);
    }
  };

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

  // Submit the entire retry set in one request; the server persists and drains it.
  const onRetryAllFailed = async (targets: TranscriptionHistoryEntry[]) => {
    if (retryingPath) return;
    try {
      await api.queueTranscriptionWork(
        targets.map((target) => ({
          kind: "file",
          input: target.inputPath,
          request: {
            postAction: target.postAction,
            outputFormat: target.outputFormat,
            model: target.model,
            language: target.language,
            device: target.device,
            computeType: target.computeType,
            advancedOptions: target.advancedOptions,
            overwrite: target.overwrite === true,
          },
        })),
      );
      void workQuery.refetch();
    } catch (e: unknown) {
      addToast(t("transcriptionHistory.retryFailed", { message: getErrorMessage(e) }), "error");
    }
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
  const { downloads: modelDownloads, downloadModel } = useModelDownload();

  // Library file list (non-mutating preview scan of MEDIA_DIR).
  const queryClient = useQueryClient();
  const completedWork = useRef(new Set<string>());
  useEffect(() => {
    const finished = (workQuery.data?.items ?? []).filter(
      (item) => item.kind === "file" && item.status === "succeeded",
    );
    if (finished.some((item) => !completedWork.current.has(item.id))) {
      for (const item of finished) completedWork.current.add(item.id);
      void queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
    }
  }, [workQuery.data, queryClient]);
  const scanQuery = useLibraryQuery(enabled && backendConfigured);
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
  // file the user cannot see is worse than forgetting it was ticked.
  const visiblePaths = useMemo(() => new Set(visibleFiles.map((f) => f.videoPath as string)), [visibleFiles]);
  const tree = useMemo(
    () => buildFolderTree(visibleFiles, sortBy, sortDir, mediaDir),
    [visibleFiles, sortBy, sortDir, mediaDir],
  );

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
    try {
      return Boolean(JSON.parse(str(settings.transcription_advanced_stt, "{}"))?.speaker_diarization);
    } catch {
      return false;
    }
  }, [settings.transcription_advanced_stt]);
  const effDiarize = diarize ?? sttDiarizationDefault;
  // URL/YouTube input offered only when the backend has yt-dlp installed.
  const canUrl = Boolean((caps as { urlInput?: boolean } | undefined)?.urlInput);
  const modelDescriptors = useMemo(() => descriptorsFrom(caps), [caps]);
  const host = transcriptionHost(caps);
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
  const saveSetting = useCallback(
    (key: string, value: string) => {
      persistSetting.mutate({ [key]: value });
    },
    [persistSetting],
  );

  useEffect(() => {
    if (!settingsQuery.isSuccess) return;
    setSortBy(validSortBy(settings.transcription_sort_by));
    setSortDir(validSortDir(settings.transcription_sort_dir));
  }, [settings.transcription_sort_by, settings.transcription_sort_dir, settingsQuery.isSuccess]);

  const handleSortByChange = useCallback(
    (value: SortBy) => {
      setSortBy(value);
      saveSetting("transcription_sort_by", value);
    },
    [saveSetting],
  );

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
    whisperModels,
    modelsQuery,
    modelDownloads,
    downloadModel,
    model,
    setModel,
    saveSetting,
    confirm,
    addToast,
    t,
  });

  // Run-options change handlers: write-through to local state + persisted setting.
  const handleLanguageChange = useCallback(
    (value: string) => {
      setLanguage(value);
      saveSetting("transcription_language", value);
    },
    [saveSetting],
  );

  const handleFormatChange = useCallback(
    (value: string) => {
      setFormat(value);
      saveSetting("transcription_output_format", value);
    },
    [saveSetting],
  );

  const handleDeviceChange = useCallback(
    (newDevice: string) => {
      setDevice(newDevice);
      // Clamp the current compute type into the valid set for the new device
      // so the persisted setting never becomes invalid (e.g. cpu+float16).
      const validComputes = COMPUTE_BY_DEVICE[newDevice] ?? ["int8"];
      const currentCompute = computeType || str(settings.transcription_compute_type, "int8");
      const clampedCompute = validComputes.includes(currentCompute) ? currentCompute : validComputes[0];
      if (clampedCompute !== computeType) setComputeType(clampedCompute);
      persistSetting.mutate({ transcription_device: newDevice, transcription_compute_type: clampedCompute });
    },
    [computeType, settings.transcription_compute_type, persistSetting],
  );

  const handleComputeChange = useCallback(
    (value: string) => {
      setComputeType(value);
      saveSetting("transcription_compute_type", value);
    },
    [saveSetting],
  );

  const handleDiarizeChange = useCallback((checked: boolean) => {
    setDiarize(checked);
  }, []);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedVisible = useMemo(
    () => Array.from(selected).filter((path) => visiblePaths.has(path)),
    [selected, visiblePaths],
  );

  const activeWork = work.filter(
    (item) => item.kind === "file" && (item.status === "queued" || item.status === "running"),
  );
  const running = activeWork.length > 0;
  const activePath = activeWork.find((item) => item.status === "running")?.input ?? null;
  const currentBatch = activeWork.length ? work.filter((item) => item.batchId === activeWork[0].batchId) : [];
  const progress = running
    ? {
        done: currentBatch.filter((item) => !["queued", "running"].includes(item.status)).length,
        total: currentBatch.length,
      }
    : null;
  const fileProgress = Object.fromEntries(
    work
      .filter((item) => item.kind === "file")
      .map((item) => [
        item.input,
        {
          pct: item.progress,
          done: item.status === "succeeded",
          error: item.status === "failed",
          cancelled: item.status === "cancelled",
          phase: item.status === "queued" ? "waiting_for_gpu" : undefined,
        },
      ]),
  );
  const cancelBatch = async () => {
    await Promise.all(cancellableBatchIds(work, currentBatch[0]?.batchId).map((id) => api.cancelTranscriptionWork(id)));
    void workQuery.refetch();
  };

  // Expand/collapse is persisted per folder in localStorage (default collapsed)
  // and pruned against the folders present after each scan. Prune against the
  // unfiltered tree so narrowing the filter can't silently discard state.
  const fullTree = useMemo(
    () => buildFolderTree(videoFiles, sortBy, sortDir, mediaDir),
    [videoFiles, sortBy, sortDir, mediaDir],
  );
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

  // Progress is always re-fetched after reconnect; SSE only speeds up updates.
  useSSE(
    useCallback(
      (type, data) => {
        if (type === "transcription:work") {
          void queryClient.invalidateQueries({ queryKey: ["transcription-work"] });
          if (data.status === "succeeded") void queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
        }
      },
      [queryClient],
    ),
  );

  const toggle = (vp: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(vp)) next.delete(vp);
      else next.add(vp);
      return next;
    });
  const toggleFolder = (paths: string[]) => {
    const allSelected = paths.length > 0 && paths.every((p) => selected.has(p));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (allSelected) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(visibleFiles.map((f) => f.videoPath as string)));

  const transcribeSelected = async () => {
    const paths = selectedVisible;
    if (paths.length === 0 || running) return;

    // Gate 1: check the selected model is downloaded before we start the batch.
    // On decline, cancel the run (leave model selected, do nothing else).
    const modelReady = await ensureModelDownloaded(effModel);
    if (!modelReady) return;

    const withSubs = visibleFiles.filter((f) => f.videoPath && paths.includes(f.videoPath) && f.subtitles.length > 0);
    // Reaching the run means the user agreed to replace these videos' subtitles.
    const overwritten = new Set(withSubs.map((f) => f.videoPath as string));
    if (withSubs.length > 0) {
      const ok = await confirm({
        title: t("whisper.overwriteTitle"),
        message: t("whisper.overwriteConfirm", { count: withSubs.length }),
      });
      if (!ok) return;
    }
    try {
      await api.queueTranscriptionWork(
        paths.map((videoPath) => ({
          kind: "file",
          input: videoPath,
          request: {
            outputFormat: effFormat,
            postAction: "transcribe_only",
            model: effModel,
            language: effLang,
            device: effDevice,
            computeType: effCompute,
            speakerDiarization: canDiarize && effDiarize,
            overwrite: overwritten.has(videoPath),
          },
        })),
      );
      setSelected(new Set());
      void workQuery.refetch();
    } catch (e: unknown) {
      addToast(getErrorMessage(e), "error");
    }
  };

  const downloadsActive = Object.values(modelDownloads).some((dl) => dl.active);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("nav.whisper")} />
      <div className="flex-1 overflow-auto">
        <div className={`mx-auto w-full max-w-[1100px] space-y-4 ${isMobile ? "p-3 pb-24" : "p-6"}`}>
          <p className="text-sm text-muted">{t("whisper.subtitle")}</p>

          {!enabled && (
            <div className="rounded-md border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning">
              <Icon name="warning" /> {t("whisper.disabledNotice")}{" "}
              <Link to="/settings" className="underline">
                {t("whisper.openSettings")}
              </Link>
            </div>
          )}

          {/* Enabled but no backend URL saved: without this the whole picker is
          hidden with no explanation of why. */}
          {enabled && !backendConfigured && (
            <div className="rounded-md border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning">
              <Icon name="warning" /> {t("whisper.backendNotConfigured")}{" "}
              <Link to="/settings" className="underline">
                {t("whisper.openSettings")}
              </Link>
            </div>
          )}

          {enabled && backendConfigured && (
            <>
              {modelsQuery.isError && (
                <InlineError message={t("whisper.modelsLoadFailed")} onRetry={() => void modelsQuery.refetch()} />
              )}

              {/* ── 1. Run options ─────────────────────────────────────────────
              Everyday knobs stay visible; device/compute/diarize are expert
              settings and live behind the Advanced disclosure. */}
              <RunOptionsSection
                modelDescriptors={modelDescriptors}
                host={host}
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

              <AutoTranscriptionControl settings={settings} />

              {/* ── 2. Transcribe from URL (only when backend has yt-dlp) ────── */}
              {canUrl && (
                <UrlTranscribeSection
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
                mediaDir={mediaDir}
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
          <section className="rounded-md border border-border bg-surface-raised">
            <TranscriptionHistoryPanel
              attempts={attempts}
              transcribingPath={retryingPath ?? activePath}
              isRetryPending={retryingPath !== null}
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
