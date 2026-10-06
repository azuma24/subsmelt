import { useTranslation } from "react-i18next";
import { LANGUAGES, findLanguage, type LanguageEntry } from "./language-table";
import { extOf, formatBytes } from "./download-outputs";

import { effectiveSource, isSameAsTarget, type StagedFile } from "./staged-file";

export type FileRunStatus = "working" | "done" | "error";

interface StagedFileListProps {
  staged: StagedFile[];
  translate: boolean;
  resolvedTarget: LanguageEntry | null;
  fileStatus: Record<string, FileRunStatus>;
  converting: boolean;
  globalFrom?: string;
  setOverride: (id: string, code: string | null) => void;
  setSkip: (id: string, skip: boolean) => void;
  removeFile: (id: string) => void;
  clearFiles: () => void;
}

/** Staged-files list — the dropzone already serves as the empty state, so this renders nothing when empty. */
export function StagedFileList({
  staged,
  translate,
  resolvedTarget,
  fileStatus,
  converting,
  globalFrom,
  setOverride,
  setSkip,
  removeFile,
  clearFiles,
}: StagedFileListProps) {
  const { t } = useTranslation();

  if (staged.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-2)]">
          {t("convert.staged", { count: staged.length })}
        </span>
        <button
          type="button"
          onClick={clearFiles}
          className="rounded-sm px-3 py-1 text-xs font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        >
          {t("convert.clearAll")}
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {staged.map((item) => {
          const { id, file } = item;
          const source = effectiveSource(item, globalFrom);
          const sourceEntry = source ? findLanguage(source) : undefined;
          const sameAsTarget = isSameAsTarget(item, globalFrom, translate, resolvedTarget?.code ?? null);
          const status = fileStatus[id];
          return (
            <li
              key={id}
              className="flex flex-col gap-2 rounded-sm border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs uppercase text-[var(--accent)]">{extOf(file.name) || "?"}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text)]" title={file.name}>
                  {file.name}
                </span>
                {status && (
                  <span className={`shrink-0 text-xs ${status === "error" ? "text-[var(--red)]" : status === "done" ? "text-[var(--green)]" : "font-medium text-[var(--accent)]"}`}>
                    {status === "working" ? t("convert.translating") : status === "done" ? t("whisper.statusDone") : t("whisper.statusError")}
                  </span>
                )}
                <span className="shrink-0 text-xs tabular-nums text-[var(--text-3)]">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(id)}
                  aria-label={t("convert.remove")}
                  title={t("convert.remove")}
                  className="shrink-0 rounded-sm px-2 py-1 text-xs text-[var(--text-3)] transition-colors hover:bg-[var(--red-dim)] hover:text-[var(--red)]"
                >
                  ✕
                </button>
              </div>
              {translate && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Detection badge: pending → detecting; null → unknown; code → name. */}
                  <span className={`rounded-full px-2 py-1 text-xs ${item.detected === undefined ? "bg-[var(--surface-2)] text-[var(--text-3)]" : sourceEntry ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "bg-[var(--yellow-dim)] text-[var(--yellow)]"}`}>
                    {item.detected === undefined
                      ? t("convert.detecting")
                      : sourceEntry
                        ? t("convert.detectedBadge", { lang: sourceEntry.englishName })
                        : t("convert.detectUnknown")}
                  </span>
                  <select
                    value={item.override ?? ""}
                    onChange={(e) => setOverride(id, e.target.value || null)}
                    aria-label={t("convert.overrideLabel", { name: file.name })}
                    disabled={converting}
                    className="rounded-sm border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-2)]"
                  >
                    <option value="">{t("convert.sourceAuto")}</option>
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>{l.englishName}</option>
                    ))}
                  </select>
                  {sameAsTarget && (
                    <label className="flex items-center gap-2 rounded-full bg-[var(--yellow-dim)] px-2 py-1 text-xs text-[var(--yellow)]">
                      <input
                        type="checkbox"
                        checked={item.skip}
                        onChange={(e) => setSkip(id, e.target.checked)}
                        disabled={converting}
                        className="h-3 w-3 accent-[var(--yellow)]"
                      />
                      {t("convert.sameLangWarning", { lang: sourceEntry?.englishName ?? source })}
                    </label>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
