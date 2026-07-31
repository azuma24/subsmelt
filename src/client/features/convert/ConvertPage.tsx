import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type { ConvertTargetFormat } from "../../api";
import { ApiError } from "../../api";
import { PRESETS } from "../../app/constants";
import { useToast } from "../../components/Toast";
import { ActionButton, EmptyHint } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { AUTO_SOURCE_LANG } from "../tasks/translation-defaults";

const ACCEPTED_EXTS = ["srt", "vtt", "ass", "ssa"] as const;
const ACCEPT_ATTR = ACCEPTED_EXTS.map((e) => `.${e}`).join(",");
const TARGET_FORMATS: ConvertTargetFormat[] = ["srt", "vtt", "ass", "ssa"];
const LANGUAGE_OPTIONS = PRESETS.map((preset) => ({ label: preset.label, value: preset.target_lang }));

interface StagedFile {
  id: string;
  file: File;
}

interface OutputFile {
  name: string;
  content: string;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isSupported(name: string): boolean {
  return (ACCEPTED_EXTS as readonly string[]).includes(extOf(name));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Revoke on next tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function buildZipBlob(files: OutputFile[]): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Map<string, number>();
  for (const out of files) {
    const count = used.get(out.name) ?? 0;
    used.set(out.name, count + 1);
    const dot = out.name.lastIndexOf(".");
    const entryName =
      count === 0
        ? out.name
        : dot > 0
          ? `${out.name.slice(0, dot)}(${count})${out.name.slice(dot)}`
          : `${out.name}(${count})`;
    zip.file(entryName, out.content);
  }
  return zip.generateAsync({ type: "blob" });
}

export function ConvertPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [translate, setTranslate] = useState(false);
  const [sourceLang, setSourceLang] = useState(AUTO_SOURCE_LANG);
  const [targetLang, setTargetLang] = useState("English");
  const [targetFormat, setTargetFormat] = useState<ConvertTargetFormat>("srt");
  const [isDragging, setIsDragging] = useState(false);
  const [converting, setConverting] = useState(false);
  const [fileErrors, setFileErrors] = useState<{ name: string; error: string }[]>([]);
  const [lastOutputs, setLastOutputs] = useState<OutputFile[]>([]);

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
          merged.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`, file });
        }
        return merged;
      });
      setLastOutputs([]);
    },
    [addToast, t],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const removeFile = (id: string) => {
    setStaged((prev) => prev.filter((f) => f.id !== id));
    setLastOutputs([]);
  };
  const clearFiles = () => {
    setStaged([]);
    setFileErrors([]);
    setLastOutputs([]);
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
    setConverting(true);
    setFileErrors([]);
    setLastOutputs([]);
    try {
      const files = await Promise.all(
        staged.map(async ({ file }) => ({ name: file.name, content: await file.text() })),
      );
      const res = await api.convertSubtitles({
        files,
        targetFormat,
        translate,
        sourceLang,
        targetLang,
      });

      if (res.errors.length > 0) {
        setFileErrors(res.errors);
      }

      if (res.files.length === 0) {
        addToast(t("convert.allFailed"), "error", true);
        return;
      }

      setLastOutputs(res.files);
      await downloadOutputs(res.files);

      addToast(
        t(translate ? "convert.translateDownloadReady" : "convert.downloadReady", { count: res.files.length, format: targetFormat.toUpperCase() }),
        "success",
      );
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t("convert.failed");
      addToast(message, "error", true);
    } finally {
      setConverting(false);
    }
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

          {/* Drop zone */}
          <div
            role="button"
            tabIndex={0}
            aria-label={t("convert.browse")}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
              isDragging
                ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent-border)]"
            }`}
          >
            <span className="text-3xl" aria-hidden="true">📂</span>
            <p className="text-[13px] font-medium text-[var(--text)]">{t("convert.dropzone")}</p>
            <p className="text-[11.5px] text-[var(--text-3)]">{t("convert.dropzoneHint")}</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTR}
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {/* Staged file list */}
          {staged.length === 0 ? (
            <EmptyHint text={t("convert.empty")} subtext={t("convert.emptyHint")} />
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-[var(--text-2)]">
                  {t("convert.staged", { count: staged.length })}
                </span>
                <button
                  type="button"
                  onClick={clearFiles}
                  className="rounded-md px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                >
                  {t("convert.clearAll")}
                </button>
              </div>
              <ul className="flex flex-col gap-1.5">
                {staged.map(({ id, file }) => (
                  <li
                    key={id}
                    className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                  >
                    <span className="font-mono text-[10.5px] uppercase text-[var(--accent)]">{extOf(file.name) || "?"}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text)]" title={file.name}>
                      {file.name}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-3)]">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(id)}
                      aria-label={t("convert.remove")}
                      title={t("convert.remove")}
                      className="shrink-0 rounded-md px-2 py-1 text-[12px] text-[var(--text-3)] transition-colors hover:bg-[var(--red-dim)] hover:text-[var(--red)]"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Per-file errors */}
          {fileErrors.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-[var(--red)]">{t("convert.errors")}</span>
              {fileErrors.map((err) => (
                <InlineError key={err.name} message={`${err.name}: ${err.error}`} />
              ))}
            </div>
          )}

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
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
              <div className={`mt-4 grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-[var(--text-2)]">{t("convert.sourceLanguage")}</span>
                  <select
                    value={sourceLang}
                    onChange={(e) => setSourceLang(e.target.value)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value={AUTO_SOURCE_LANG}>{t("convert.sourceAuto")}</option>
                    {LANGUAGE_OPTIONS.map((lang) => (
                      <option key={lang.value} value={lang.value}>{lang.label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-[var(--text-2)]">{t("convert.targetLanguage")}</span>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  >
                    {LANGUAGE_OPTIONS.map((lang) => (
                      <option key={lang.value} value={lang.value}>{lang.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className={`flex items-end gap-3 ${isMobile ? "flex-col items-stretch" : ""}`}>
            <label className="flex flex-col gap-1.5">
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
            <ActionButton
              variant="primary"
              onClick={handleConvert}
              disabled={staged.length === 0}
              busy={converting}
              className={isMobile ? "w-full" : ""}
            >
              {converting ? t(translate ? "convert.translating" : "convert.converting") : t(translate ? "convert.translateAndConvert" : "convert.convert")}
            </ActionButton>
          </div>

          {lastOutputs.length > 0 && (
            <div className="rounded-xl border border-[var(--green-border)] bg-[var(--green-dim)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-semibold text-[var(--green)]">{t("convert.downloadsReady", { count: lastOutputs.length })}</p>
                  <p className="mt-0.5 text-[11.5px] leading-6 text-[var(--text-2)]">{t("convert.downloadsReadyHelp")}</p>
                </div>
                <ActionButton variant="success" size="sm" onClick={() => void downloadOutputs()}>
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
