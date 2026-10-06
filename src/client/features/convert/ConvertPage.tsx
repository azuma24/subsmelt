import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as api from "../../api";
import type { ConvertTargetFormat } from "../../api";
import { ApiError } from "../../api";
import { useToast } from "../../ui/Toast";
import { useLlmHealthQuery } from "../../hooks";
import { ActionButton } from "../../ui/primitives";
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

const TARGET_FORMATS: ConvertTargetFormat[] = ["srt", "vtt", "ass", "ssa"];

function getBrowserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function ConvertPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [translate, setTranslate] = useState(true);
  const [fromCode, setFromCode] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [targetFormat, setTargetFormat] = useState<ConvertTargetFormat>("srt");
  const [converting, setConverting] = useState(false);
  const [fileErrors, setFileErrors] = useState<{ name: string; error: string }[]>([]);
  const [lastOutputs, setLastOutputs] = useState<OutputFile[]>([]);
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
    return () => { cancelled = true; };
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
      setLastOutputs([]);
    },
    [addToast, t],
  );

  const removeFile = (id: string) => {
    setStaged((prev) => prev.filter((f) => f.id !== id));
    setFileErrors([]);
    setLastOutputs([]);
    setFileStatus({});
  };
  const clearFiles = () => {
    setStaged([]);
    setFileErrors([]);
    setLastOutputs([]);
    setFileStatus({});
  };

  const downloadOutputs = async (files = lastOutputs) => {
    if (files.length === 0) return;
    if (files.length === 1) {
      const out = files[0];
      triggerDownload(new Blob([out.content], { type: "text/plain;charset=utf-8" }), out.name);
      return;
    }
    const blob = await buildZipBlob(files);
    triggerDownload(blob, "subtitles.zip");
  };

  const handleConvert = async () => {
    if (staged.length === 0 || converting) return;
    if (translate && !resolvedTarget) return;
    setConverting(true);
    setFileErrors([]);
    setLastOutputs([]);
    setFileStatus({});

    // One request per file: per-file progress, and one failure never aborts
    // the rest of the batch.
    const outputs: OutputFile[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const item of staged) {
      setFileStatus((prev) => ({ ...prev, [item.id]: "working" }));
      let ok = false;
      try {
        const content = await readSubtitleFile(item.file);
        const source = effectiveSource(item, fromCode);
        const res = await api.convertSubtitles({
          files: [{
            name: item.file.name,
            content,
            sourceLang: source ? findLanguage(source)?.promptName ?? AUTO_SOURCE_LANG : AUTO_SOURCE_LANG,
            skip: skipTranslation(item, fromCode, translate, resolvedTarget?.code ?? null),
          }],
          targetFormat,
          translate,
          sourceLang: AUTO_SOURCE_LANG,
          targetLang: resolvedTarget?.promptName,
          targetCode: resolvedTarget?.code,
        });
        outputs.push(...res.files);
        errors.push(...res.errors);
        ok = res.errors.length === 0 && res.files.length > 0;
      } catch (error) {
        errors.push({ name: item.file.name, error: error instanceof ApiError ? error.message : t("convert.failed") });
      }
      setFileStatus((prev) => ({ ...prev, [item.id]: ok ? "done" : "error" }));
    }

    setConverting(false);
    if (errors.length > 0) setFileErrors(errors);
    if (outputs.length === 0) {
      addToast(t("convert.allFailed"), "error", { persistent: true });
      return;
    }

    if (translate && resolvedTarget && storage) {
      setRecents(pushRecentTarget(storage, resolvedTarget.code));
    }
    setLastOutputs(outputs);
    await downloadOutputs(outputs);
    addToast(
      t(translate ? "convert.translateDownloadReady" : "convert.downloadReady", { count: outputs.length, format: targetFormat.toUpperCase() }),
      "success",
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 md:px-4">
        <h1 className="text-sm font-semibold text-text">{t("nav.convert")}</h1>
      </div>

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

            <div className="mt-3 inline-flex rounded-sm border border-border bg-surface-raised p-1" role="tablist" aria-label={t("convert.outputSettings")}>
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
                    <select
                      value={fromCode}
                      onChange={(e) => setFromCode(e.target.value)}
                      className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm text-text focus:border-accent"
                    >
                      <option value="">{t("convert.sourceAuto")}</option>
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>{l.englishName}</option>
                      ))}
                    </select>
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
                  <Link to="/settings" className="underline">{t("whisper.openSettings")}</Link>
                </p>
              )}

              <label className="flex flex-col gap-2 sm:max-w-[220px]">
                <span className="text-xs font-medium text-muted">{t("convert.targetFormat")}</span>
                <select
                  value={targetFormat}
                  onChange={(e) => setTargetFormat(e.target.value as ConvertTargetFormat)}
                  className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm text-text focus:border-accent"
                >
                  {TARGET_FORMATS.map((fmt) => (
                    <option key={fmt} value={fmt}>
                      {fmt.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {/* Action — the CTA stands alone so it isn't mistaken for another setting */}
          <div className={`flex items-center gap-3 ${isMobile ? "flex-col items-stretch" : "justify-end"}`}>
            {staged.length === 0 && (
              <span className="text-xs text-faint">{t("convert.addFilesToStart")}</span>
            )}
            <ActionButton
              variant="primary"
              onClick={handleConvert}
              disabled={staged.length === 0 || (translate && !resolvedTarget) || (translate && llmHealth.isSuccess && !llmReady)}
              busy={converting}
              className={isMobile ? "w-full" : ""}
            >
              {converting ? t(translate ? "convert.translating" : "convert.converting") : t(translate ? "convert.modeTranslate" : "convert.convert")}
            </ActionButton>
          </div>

          {lastOutputs.length > 0 && (
            <div className="rounded-md border border-success-line bg-success-soft p-4" role="status" aria-live="polite">
              <div className={`flex gap-3 ${isMobile ? "flex-col items-stretch" : "items-center justify-between"}`}>
                <div>
                  <p className="text-sm font-semibold text-success">{t("convert.downloadsReady", { count: lastOutputs.length })}</p>
                  <p className="mt-1 text-xs leading-6 text-muted">{t("convert.downloadsReadyHelp")}</p>
                </div>
                <ActionButton variant="success" size="sm" onClick={() => void downloadOutputs()} className={isMobile ? "w-full" : ""}>
                  {lastOutputs.length === 1 ? t("convert.downloadFile") : t("convert.downloadZip")}
                </ActionButton>
              </div>
              {lastOutputs.length > 1 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {lastOutputs.map((out) => (
                    <button
                      key={out.name}
                      type="button"
                      onClick={() => triggerDownload(new Blob([out.content], { type: "text/plain;charset=utf-8" }), out.name)}
                      className="rounded-sm border border-success-line bg-surface px-3 py-1 text-xs text-muted hover:text-text"
                    >
                      {out.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
