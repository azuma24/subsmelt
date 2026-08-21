import { useTranslation } from "react-i18next";
import { LANGUAGES, findLanguage, type LanguageEntry } from "./language-table";
import { extOf, formatBytes } from "./download-outputs";

export interface StagedFile {
  id: string;
  file: File;
  /** Detected source language code; undefined = not attempted yet, null = detection failed. */
  detected?: string | null;
  /** Manual per-file source override (language code); null = trust detection. */
  override: string | null;
  /** Skip translation for this file (convert format only). */
  skip: boolean;
}

export type FileRunStatus = "working" | "done" | "error";

/** Effective source code for a file: manual override wins over detection. */
export function effectiveSource(s: StagedFile): string | null {
  return s.override ?? s.detected ?? null;
}

interface StagedFileListProps {
  staged: StagedFile[];
  translate: boolean;
  resolvedTarget: LanguageEntry | null;
  fileStatus: Record<string, FileRunStatus>;
  converting: boolean;
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
        {staged.map((item) => {
          const { id, file } = item;
          const source = effectiveSource(item);
          const sourceEntry = source ? findLanguage(source) : undefined;
          const sameAsTarget = Boolean(translate && resolvedTarget && source && source === resolvedTarget.code);
          const status = fileStatus[id];
          return (
            <li
              key={id}
              className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10.5px] uppercase text-[var(--accent)]">{extOf(file.name) || "?"}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text)]" title={file.name}>
                  {file.name}
                </span>
                {status && (
                  <span className={`shrink-0 text-[10.5px] ${status === "error" ? "text-[var(--red)]" : status === "done" ? "text-[var(--green)]" : "font-medium text-[var(--accent)]"}`}>
                    {status === "working" ? t("convert.translating") : status === "done" ? t("whisper.statusDone") : t("whisper.statusError")}
                  </span>
                )}
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
              </div>
              {translate && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Detection badge: pending → detecting; null → unknown; code → name. */}
                  <span className={`rounded-full px-2 py-0.5 text-[10.5px] ${item.detected === undefined ? "bg-[var(--surface-2)] text-[var(--text-3)]" : sourceEntry ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "bg-[var(--yellow-dim)] text-[var(--yellow)]"}`}>
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
                    className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-2)]"
                  >
                    <option value="">{t("convert.sourceAuto")}</option>
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>{l.englishName}</option>
                    ))}
                  </select>
                  {sameAsTarget && (
                    <label className="flex items-center gap-1.5 rounded-full bg-[var(--yellow-dim)] px-2 py-0.5 text-[10.5px] text-[var(--yellow)]">
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
