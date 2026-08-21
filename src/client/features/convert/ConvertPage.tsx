import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type { ConvertTargetFormat } from "../../api";
import { ApiError } from "../../api";
import { useToast } from "../../components/Toast";
import { ActionButton } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { AUTO_SOURCE_LANG } from "../tasks/translation-defaults";
import type { KeyValueStorage } from "../../components/file-tree/expansion-store";
import { findLanguage } from "./language-table";
import { resolveTargetLanguage } from "./resolve-language";
import { sampleCueText } from "./cue-sample";
import { detectSampleLanguage } from "./detect-language";
import { loadRecentTargets, pushRecentTarget } from "./recent-targets";
import { TargetLanguageField } from "./TargetLanguageField";
import { DropZone } from "./DropZone";
import { StagedFileList, effectiveSource, type StagedFile, type FileRunStatus } from "./StagedFileList";
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
  const [translate, setTranslate] = useState(false);
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

  // Detect each staged file's source language once translation is enabled.
  // Sequential and cancellable; results land per file as they arrive.
  useEffect(() => {
    if (!translate) return;
    const todo = staged.filter((s) => s.detected === undefined);
    if (todo.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const item of todo) {
        const text = await item.file.text().catch(() => "");
        const code = detectSampleLanguage(sampleCueText(text));
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
        const content = await item.file.text();
        const source = effectiveSource(item);
        const res = await api.convertSubtitles({
          files: [{
            name: item.file.name,
            content,
            sourceLang: source ? findLanguage(source)?.promptName ?? AUTO_SOURCE_LANG : AUTO_SOURCE_LANG,
            skip: item.skip,
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
      addToast(t("convert.allFailed"), "error", true);
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
      <div className={`sticky top-0 z-30 shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 md:px-[18px] ${isMobile ? "space-y-2" : ""}`}>
        <div className="flex min-h-[42px] items-center gap-2.5">
          <span className="text-sm font-semibold text-[var(--text)]">{t("convert.title")}</span>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3.5 md:p-[18px]">
        <div className="mx-auto flex max-w-[680px] flex-col gap-4">
          <p className="text-[13px] leading-6 text-[var(--text-2)]">{t("convert.description")}</p>

          <DropZone onFiles={addFiles} />

          <StagedFileList
            staged={staged}
            translate={translate}
            resolvedTarget={resolvedTarget}
            fileStatus={fileStatus}
            converting={converting}
            setOverride={setOverride}
            setSkip={setSkip}
            removeFile={removeFile}
            clearFiles={clearFiles}
          />

          {/* Per-file errors */}
          {fileErrors.length > 0 && (
            <div className="flex flex-col gap-1.5" role="alert" aria-live="assertive">
              <span className="text-[12px] font-medium text-[var(--red)]">{t("convert.errors")}</span>
              {fileErrors.map((err) => (
                <InlineError key={err.name} message={`${err.name}: ${err.error}`} />
              ))}
            </div>
          )}

          {/* Output settings — format and optional translation, grouped as one concern */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text)]">{t("convert.outputSettings")}</h2>

            <div className="mt-3 flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 sm:max-w-[220px]">
                <span className="text-[12px] font-medium text-[var(--text-2)]">{t("convert.targetFormat")}</span>
                <select
                  value={targetFormat}
                  onChange={(e) => setTargetFormat(e.target.value as ConvertTargetFormat)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                >
                  {TARGET_FORMATS.map((fmt) => (
                    <option key={fmt} value={fmt}>
                      {fmt.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>

              <div className="border-t border-[var(--border)] pt-4">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={translate}
                    onChange={(e) => setTranslate(e.target.checked)}
                    className="mt-1 h-4 w-4 accent-[var(--accent)]"
                  />
                  <span>
                    <span className="block text-[13px] font-semibold text-[var(--text)]">{t("convert.translateToggle")}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-6 text-[var(--text-3)]">{t("convert.translateToggleHelp")}</span>
                  </span>
                </label>

                {translate && (
                  <div className={`mt-4 ${isMobile ? "" : "max-w-[420px]"}`}>
                    {/* Source language is auto-detected per file (badges on the
                        rows above); only the target needs input. */}
                    <TargetLanguageField
                      value={targetInput}
                      onChange={setTargetInput}
                      resolution={resolution}
                      recents={recents}
                      onPick={pickTarget}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Action — the CTA stands alone so it isn't mistaken for another setting */}
          <div className={`flex items-center gap-3 ${isMobile ? "flex-col items-stretch" : "justify-end"}`}>
            {staged.length === 0 && (
              <span className="text-[11.5px] text-[var(--text-3)]">{t("convert.addFilesToStart")}</span>
            )}
            <ActionButton
              variant="primary"
              onClick={handleConvert}
              disabled={staged.length === 0 || (translate && !resolvedTarget)}
              busy={converting}
              className={isMobile ? "w-full" : ""}
            >
              {converting ? t(translate ? "convert.translating" : "convert.converting") : t(translate ? "convert.translateAndConvert" : "convert.convert")}
            </ActionButton>
          </div>

          {lastOutputs.length > 0 && (
            <div className="rounded-xl border border-[var(--green-border)] bg-[var(--green-dim)] p-4" role="status" aria-live="polite">
              <div className={`flex gap-3 ${isMobile ? "flex-col items-stretch" : "items-center justify-between"}`}>
                <div>
                  <p className="text-[13px] font-semibold text-[var(--green)]">{t("convert.downloadsReady", { count: lastOutputs.length })}</p>
                  <p className="mt-0.5 text-[11.5px] leading-6 text-[var(--text-2)]">{t("convert.downloadsReadyHelp")}</p>
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
                      className="rounded-md border border-[var(--green-border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] text-[var(--text-2)] hover:text-[var(--text)]"
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
