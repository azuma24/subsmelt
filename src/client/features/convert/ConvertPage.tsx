import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { Link } from "react-router-dom";
import * as api from "../../api";
import type { ConvertTargetFormat } from "../../api";
import { ApiError } from "../../api";
import { useToast } from "../../ui/Toast";
import { useLlmHealthQuery, useIsMobile } from "../../hooks";
import { ActionButton, PageHeader, Select } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { AUTO_SOURCE_LANG } from "../tasks/translation-defaults";
import type { KeyValueStorage } from "../../ui/file-tree/expansion-store";
import { LANGUAGES, findLanguage } from "./language-table";
import { resolveTargetLanguage } from "./resolve-language";
import { sampleCueText } from "./cue-sample";
import { loadRecentTargets, pushRecentTarget } from "./recent-targets";
import { TargetLanguageField } from "./TargetLanguageField";
import { DropZone } from "./DropZone";
import { StagedFileList, type FileRunStatus } from "./StagedFileList";
import { effectiveSource, skipTranslation, type StagedFile } from "./staged-file";
import { detectSampleLanguage, readSubtitleFile } from "./lazy-analysis";
import { isSupported, triggerDownload, buildZipBlob, type OutputFile } from "./download-outputs";
import { shouldAutoDownload } from "./batch-auto-download";

const BATCH_KEY = "subsmelt.convert.batch";
const MAX_FILES = 10;
const MAX_BYTES = 1024 * 1024;

const TARGET_FORMATS: ConvertTargetFormat[] = ["srt", "vtt", "ass", "ssa"];

function getBrowserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function ConvertPage() {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [translate, setTranslate] = useState(true);
  const [fromCode, setFromCode] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [targetFormat, setTargetFormat] = useState<ConvertTargetFormat>("srt");
  const [converting, setConverting] = useState(false);
  const [fileErrors, setFileErrors] = useState<{ name: string; error: string }[]>([]);
  const [batchId, setBatchId] = useState<string | null>(() => getBrowserStorage()?.getItem(BATCH_KEY) ?? null);
  const [batch, setBatch] = useState<api.ConvertBatch | null>(null);
  const [history, setHistory] = useState<api.ConvertBatch[]>([]);
  const autoDownloadId = useRef<string | null>(null);
  const [autoDownloadedId, setAutoDownloadedId] = useState<string | null>(null);
  const [batchError, setBatchError] = useState("");
  const [fileStatus, setFileStatus] = useState<Record<string, FileRunStatus>>({});

  const storage = useMemo(getBrowserStorage, []);
  const [recents, setRecents] = useState<string[]>(() => (storage ? loadRecentTargets(storage) : []));
  const resolution = useMemo(() => resolveTargetLanguage(targetInput), [targetInput]);
  const resolvedTarget = resolution.status === "resolved" ? resolution.language : null;
  const llmHealth = useLlmHealthQuery(translate);
  const llmReady = Boolean(llmHealth.data?.ok);

  // Detect each staged file's source language once translation is enabled.
  // Sequential and cancellable; results land per file as they arrive.
  useEffect(() => {
    if (!translate) return;
    const todo = staged.filter((s) => s.detected === undefined);
    if (todo.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const item of todo) {
        const text = await readSubtitleFile(item.file).catch(() => "");
        const code = await detectSampleLanguage(sampleCueText(text));
        if (cancelled) return;
        setStaged((prev) => prev.map((s) => (s.id === item.id ? { ...s, detected: code } : s)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [translate, staged]);

  const pickTarget = useCallback((entry: { code: string; englishName: string }) => {
    setTargetInput(entry.code);
  }, []);

  const setOverride = (id: string, code: string | null) =>
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, override: code } : s)));
  const setSkip = (id: string, skip: boolean) =>
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, skip } : s)));

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      const supported = list.filter((f) => isSupported(f.name));
      const rejected = list.length - supported.length;
      if (rejected > 0) {
        addToast(t("convert.unsupported", { count: rejected }), "error");
      }
      if (supported.length === 0) return;
      setStaged((prev) => {
        const merged = [...prev];
        for (const file of supported) {
          merged.push({
            id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
            file,
            override: null,
            skip: false,
          });
        }
        return merged;
      });
      setFileStatus({});
      // The staged set changed, so any prior per-file errors/outputs now refer to
      // a stale list — clear them (mirrors clearFiles).
      setFileErrors([]);
      // Existing server batch remains available until expiry.
    },
    [addToast, t],
  );

  const removeFile = (id: string) => {
    setStaged((prev) => prev.filter((f) => f.id !== id));
    setFileErrors([]);
    setFileStatus({});
  };
  const clearFiles = () => {
    setStaged([]);
    setFileErrors([]);
    setFileStatus({});
  };

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const { batches } = await api.listConvertBatches();
        if (!cancelled) {
          setHistory(batches);
          setBatchId((current) => current ?? batches[0]?.id ?? null);
        }
      } catch {
        // Keep polling a selected batch if listing is temporarily unavailable.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.getConvertBatch(batchId);
        if (!cancelled) {
          setBatch(next);
          setBatchError("");
        }
      } catch (error) {
        if (!cancelled)
          setBatchError(
            error instanceof ApiError && error.status === 404 ? t("convert.batchUnavailable") : t("convert.failed"),
          );
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchId, t]);

  const downloadOutputs = useCallback(async () => {
    if (!batchId || !batch) return;
    try {
      const outputs = await Promise.all(
        batch.files.map(async (file, index) =>
          file.status === "done"
            ? { name: file.outputName!, content: await api.getConvertBatchFile(batchId, index) }
            : null,
        ),
      );
      const files = outputs.filter((file): file is OutputFile => file !== null);
      if (files.length === 1)
        triggerDownload(new Blob([files[0].content], { type: "text/plain;charset=utf-8" }), files[0].name);
      else if (files.length > 1) triggerDownload(await buildZipBlob(files), "subtitles.zip");
    } catch {
      addToast(t("convert.failed"), "error");
    }
  }, [batchId, batch, addToast, t]);

  useEffect(() => {
    if (!batch || !shouldAutoDownload(batch, autoDownloadId.current)) return;
    autoDownloadId.current = null;
    setAutoDownloadedId(batch.id);
    void downloadOutputs();
  }, [batch, downloadOutputs]);

  const handleConvert = async () => {
    if (staged.length === 0 || converting || (translate && !resolvedTarget)) return;
    if (staged.length > MAX_FILES || staged.some((item) => item.file.size > MAX_BYTES)) {
      addToast(t("convert.batchLimit"), "error");
      return;
    }
    setConverting(true);
    setBatchError("");
    try {
      const files = await Promise.all(
        staged.map(async (item) => {
          const source = effectiveSource(item, fromCode);
          return {
            name: item.file.name,
            content: await readSubtitleFile(item.file),
            sourceLang: source ? (findLanguage(source)?.promptName ?? AUTO_SOURCE_LANG) : AUTO_SOURCE_LANG,
            skip: skipTranslation(item, fromCode, translate, resolvedTarget?.code ?? null),
          };
        }),
      );
      const { id } = await api.createConvertBatch({
        files,
        targetFormat,
        translate,
        sourceLang: AUTO_SOURCE_LANG,
        targetLang: resolvedTarget?.promptName,
        targetCode: resolvedTarget?.code,
      });
      storage?.setItem(BATCH_KEY, id);
      autoDownloadId.current = id;
      setBatch(null);
      setBatchId(id);
      if (translate && resolvedTarget && storage) setRecents(pushRecentTarget(storage, resolvedTarget.code));
    } catch (error) {
      addToast(error instanceof ApiError ? error.message : t("convert.failed"), "error");
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("nav.convert")} />

      <div className="flex-1 overflow-auto p-4 md:p-4">
        <div className="mx-auto flex max-w-[680px] flex-col gap-4">
          <p className="text-sm leading-6 text-muted">{t("convert.description")}</p>

          <DropZone onFiles={addFiles} />

          <StagedFileList
            staged={staged}
            translate={translate}
            resolvedTarget={resolvedTarget}
            fileStatus={fileStatus}
            converting={converting}
            globalFrom={fromCode}
            setOverride={setOverride}
            setSkip={setSkip}
            removeFile={removeFile}
            clearFiles={clearFiles}
          />

          {/* Per-file errors */}
          {fileErrors.length > 0 && (
            <div className="flex flex-col gap-2" role="alert" aria-live="assertive">
              <span className="text-xs font-medium text-danger">{t("convert.errors")}</span>
              {fileErrors.map((err) => (
                <InlineError key={err.name} message={`${err.name}: ${err.error}`} />
              ))}
            </div>
          )}

          <div className="rounded-md border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-text">{t("convert.outputSettings")}</h2>

            <div
              className="mt-3 inline-flex rounded-sm border border-border bg-surface-raised p-1"
              role="tablist"
              aria-label={t("convert.outputSettings")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={!translate}
                onClick={() => setTranslate(false)}
                className={`rounded-sm px-3 py-2 text-xs font-medium ${!translate ? "bg-surface text-text shadow-1" : "text-muted"}`}
              >
                {t("convert.modeFormat")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={translate}
                onClick={() => setTranslate(true)}
                className={`rounded-sm px-3 py-2 text-xs font-medium ${translate ? "bg-surface text-text shadow-1" : "text-muted"}`}
              >
                {t("convert.modeTranslate")}
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-4">
              {translate && (
                <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-muted">{t("convert.sourceLanguage")}</span>
                    <Select value={fromCode} onChange={(value) => setFromCode(value)}>
                      <option value="">{t("convert.sourceAuto")}</option>
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.englishName}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <TargetLanguageField
                    value={targetInput}
                    onChange={setTargetInput}
                    resolution={resolution}
                    recents={recents}
                    onPick={pickTarget}
                  />
                </div>
              )}

              {translate && llmHealth.isSuccess && !llmReady && (
                <p className="text-xs text-warning">
                  {t("convert.needLlm")}{" "}
                  <Link to="/settings" className="underline">
                    {t("whisper.openSettings")}
                  </Link>
                </p>
              )}

              <label className="flex flex-col gap-2 sm:max-w-[220px]">
                <span className="text-xs font-medium text-muted">{t("convert.targetFormat")}</span>
                <Select value={targetFormat} onChange={(value) => setTargetFormat(value as ConvertTargetFormat)}>
                  {TARGET_FORMATS.map((fmt) => (
                    <option key={fmt} value={fmt}>
                      {fmt.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          </div>

          {/* Action — the CTA stands alone so it isn't mistaken for another setting */}
          <div className={`flex items-center gap-3 ${isMobile ? "flex-col items-stretch" : "justify-end"}`}>
            {staged.length === 0 && <span className="text-xs text-faint">{t("convert.addFilesToStart")}</span>}
            <ActionButton
              variant="primary"
              onClick={handleConvert}
              disabled={
                staged.length === 0 || (translate && !resolvedTarget) || (translate && llmHealth.isSuccess && !llmReady)
              }
              busy={converting}
              className={isMobile ? "w-full" : ""}
            >
              {converting
                ? t(translate ? "convert.translating" : "convert.converting")
                : t(translate ? "convert.modeTranslate" : "convert.convert")}
            </ActionButton>
          </div>

          {history.length > 0 && (
            <div className="rounded-md border border-border bg-surface p-3">
              <p className="text-xs font-medium text-muted">{t("convert.recentBatches")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      autoDownloadId.current = null;
                      setBatch(null);
                      setBatchId(item.id);
                      storage?.setItem(BATCH_KEY, item.id);
                    }}
                    aria-pressed={batchId === item.id}
                    className={`rounded-sm border px-2 py-1 text-xs ${batchId === item.id ? "border-success text-text" : "border-border text-muted"}`}
                  >
                    {item.files[0]?.name} · {t(`convert.batchStatus.${item.status}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {batchId && (
            <div className="rounded-md border border-success-line bg-success-soft p-4" role="status" aria-live="polite">
              <p className="text-sm font-semibold text-success">
                {batch?.status === "done"
                  ? t("convert.downloadsReady", { count: batch.files.filter((file) => file.status === "done").length })
                  : t("convert.converting")}
              </p>
              <p className="mt-1 text-xs text-muted">
                {batchError ||
                  (batch?.status === "done"
                    ? t(batch.id === autoDownloadedId ? "convert.downloadsReadyHelp" : "convert.downloadsAvailableHelp")
                    : t("convert.serverProcessing"))}
              </p>
              {batch?.files.map((file, index) => (
                <div key={`${index}-${file.name}`} className="mt-2 text-xs text-muted">
                  {file.name}: {t(`convert.batchStatus.${file.status}`)}
                  {file.error ? ` — ${file.error}` : ""}
                  {file.status === "done" && (
                    <button
                      type="button"
                      className="ml-2 underline"
                      onClick={() =>
                        void api
                          .getConvertBatchFile(batchId, index)
                          .then((content) =>
                            triggerDownload(
                              new Blob([content], { type: "text/plain;charset=utf-8" }),
                              file.outputName!,
                            ),
                          )
                          .catch(() => addToast(t("convert.failed"), "error"))
                      }
                    >
                      {t("convert.downloadFile")}
                    </button>
                  )}
                </div>
              ))}
              {batch?.files.some((file) => file.status === "done") && (
                <ActionButton variant="success" size="sm" onClick={() => void downloadOutputs()}>
                  {batch.files.filter((file) => file.status === "done").length === 1
                    ? t("convert.downloadFile")
                    : t("convert.downloadZip")}
                </ActionButton>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
