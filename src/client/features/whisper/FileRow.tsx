import { useTranslation } from "react-i18next";
import type { ScannedFile } from "../../types";
import { baseName, type FileProgress } from "./whisper-shared";

interface FileRowProps {
  file: ScannedFile;
  padLeftPx: number;
  /** When set (filter mode), the row is labelled by relative path, not name. */
  relPath?: string;
  selected: Set<string>;
  toggleFile: (vp: string) => void;
  fileProgress: Record<string, FileProgress>;
  activePath: string | null;
  running: boolean;
}

export function FileRow({ file, padLeftPx, relPath, selected, toggleFile, fileProgress, activePath, running }: FileRowProps) {
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
      style={{ paddingLeft: `${padLeftPx}px` }}>
      {/* Selection is frozen mid-batch: the run works from the list captured at
          start, so letting it change would misrepresent what is queued. */}
      <input type="checkbox" checked={selected.has(vp)} disabled={running} onChange={() => toggleFile(vp)} className="h-4 w-4 accent-[var(--accent)]" />
      <span className="truncate"><span aria-hidden="true">🎬</span> {relPath ?? (file.videoName || baseName(vp))}</span>
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
