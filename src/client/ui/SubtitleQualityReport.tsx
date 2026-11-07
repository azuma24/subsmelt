import { useState } from "react";
import type { SubtitleQualityIssue } from "../../shared/subtitle-quality";
import { useSubtitleWarningsEnabled } from "../hooks";
import { useTranslation } from "../i18n";

const PAGE_SIZE = 25;

export function SubtitleQualityReport({
  issues,
  label,
  onCue,
  lastCue,
  advisory = false,
}: {
  issues: SubtitleQualityIssue[];
  label: string;
  onCue?: (cue: number) => void;
  lastCue?: number;
  advisory?: boolean;
}) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const showWarnings = useSubtitleWarningsEnabled();
  if (!showWarnings) return null;
  if (!issues.length) return <p className="text-xs text-muted">{t("subtitleQuality.clear")}</p>;

  return (
    <details
      className={`rounded-sm border px-3 py-2 text-xs ${advisory ? "border-border bg-surface-raised" : "border-warning-line bg-warning-soft"}`}
    >
      <summary className="cursor-pointer font-medium text-text">
        {label} <span className={`ml-1 font-mono ${advisory ? "text-muted" : "text-warning"}`}>{issues.length}</span>
      </summary>
      <ul className="mt-2 space-y-1.5 text-muted">
        {issues.slice(0, limit).map(({ cue, line, code, value, limit }, index) => (
          <li key={`${cue ?? line ?? "file"}-${code}-${index}`} className="flex flex-wrap items-baseline gap-x-2">
            {cue !== undefined &&
              (onCue && (lastCue === undefined || cue <= lastCue) ? (
                <button type="button" className="font-medium text-accent underline" onClick={() => onCue(cue)}>
                  {t("subtitleQuality.cue", { number: cue })}
                </button>
              ) : (
                <span className="font-medium text-text">{t("subtitleQuality.cue", { number: cue })}</span>
              ))}
            {line !== undefined && (
              <span className="font-medium text-text">{t("subtitleQuality.line", { number: line })}</span>
            )}
            <span>{t(`subtitleQuality.${code}`, { value, limit })}</span>
          </li>
        ))}
      </ul>
      {issues.length > limit && (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE_SIZE)}
          className="mt-2 font-medium text-accent underline"
        >
          {t("subtitleQuality.more")}
        </button>
      )}
    </details>
  );
}
