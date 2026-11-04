import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n";

const TICK_MS = 1_000;

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Stands in for the progress bar during the analysis pass, when no cue can finish yet. */
export function AnalyzingLabel({ since }: { since: number }) {
  const { t } = useTranslation();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="text-xs text-muted" role="status">
      {t("dashboard.analyzingFile")} <span className="font-mono">{elapsed(since)}</span>
    </span>
  );
}
