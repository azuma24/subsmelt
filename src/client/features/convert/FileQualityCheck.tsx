import { useState } from "react";
import type { SubtitleQualityIssue } from "../../../shared/subtitle-quality";
import { useTranslation } from "../../i18n";
import { SubtitleQualityReport } from "../../ui/SubtitleQualityReport";
import { checkSubtitleFile } from "./lazy-analysis";

export function FileQualityCheck({ file }: { file: File }) {
  const { t } = useTranslation();
  const [issues, setIssues] = useState<SubtitleQualityIssue[] | null>(null);
  const [status, setStatus] = useState<"idle" | "checking" | "error">("idle");

  const check = async () => {
    setStatus("checking");
    try {
      setIssues(await checkSubtitleFile(file));
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  return issues ? (
    <SubtitleQualityReport issues={issues} label={t("subtitleQuality.warnings")} />
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={status === "checking"}
        onClick={() => void check()}
        className="rounded-sm border border-border px-2 py-1 text-xs text-muted hover:text-text"
      >
        {t(status === "checking" ? "subtitleQuality.checking" : "subtitleQuality.check")}
      </button>
      {status === "error" && (
        <p role="alert" className="text-xs text-danger">
          {t("subtitleQuality.failed")}
        </p>
      )}
    </div>
  );
}
