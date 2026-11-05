import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { useToast } from "../../ui/Toast";
import { ActionButton } from "../../ui/primitives";
import { getErrorMessage } from "../../lib/errors";
import { correctionRuleError, type CorrectionRuleSet, type ScanReport } from "../../../shared/corrections";
import { MatchList, fixable } from "./MatchList";

/**
 * "Preview on my files": a dry run of a list over its folders, and the apply
 * step for the files left ticked. Applying waits for the list to be saved, so
 * what is written to files is always what is stored.
 */
export function ListFilePreview({ list, saved }: { list: CorrectionRuleSet; saved: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [report, setReport] = useState<ScanReport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [retranslate, setRetranslate] = useState(true);
  const [busy, setBusy] = useState(false);
  const rules = list.rules.filter((rule) => rule.enabled && rule.find && !correctionRuleError(rule));

  const run = async () => {
    setBusy(true);
    try {
      const result = await api.scanCorrections({ rules, folders: list.paths });
      setReport(result);
      setSelected(new Set(result.matches.filter(fixable).map((m) => m.path)));
    } catch (error) {
      addToast(getErrorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const chosen = report?.matches.filter((m) => selected.has(m.path)) ?? [];
  const jobs = chosen.flatMap((m) => m.jobs);
  const tokens = jobs.reduce((sum, job) => sum + job.tokens, 0);

  const apply = async () => {
    setBusy(true);
    try {
      const result = await api.applyCorrections({
        rules,
        files: chosen.map((m) => m.path),
        retranslate: jobs.length > 0 && retranslate,
      });
      addToast(
        [
          t("corrections.fix.doneFixed", {
            count: result.totalFixed,
            files: result.results.filter((r) => r.total).length,
          }),
          result.retranslated ? t("corrections.fix.doneRetranslate", { count: result.retranslated }) : "",
        ]
          .filter(Boolean)
          .join(" "),
        "success",
      );
      setReport(null);
      await Promise.all(["jobs", "library"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    } catch (error) {
      addToast(getErrorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!rules.length || !list.paths.length) return null;
  return (
    <div className="space-y-2 text-xs">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded-sm py-1 text-accent hover:underline disabled:opacity-50"
      >
        {report ? t("corrections.preview.again") : t("corrections.preview.run")}
      </button>
      {report && (
        <div className="space-y-3">
          <MatchList report={report} selected={selected} onChange={setSelected} />
          {jobs.length > 0 && (
            <label className="flex items-start gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={retranslate}
                onChange={(e) => setRetranslate(e.target.checked)}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span>
                {t("corrections.fix.retranslate", { count: jobs.length })}
                {tokens > 0 && (
                  <span className="block text-xs text-muted">
                    {t("corrections.fix.retranslateCost", { tokens: tokens.toLocaleString() })}
                  </span>
                )}
              </span>
            </label>
          )}
          {chosen.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton size="sm" onClick={() => void apply()} busy={busy} disabled={!saved}>
                {t("corrections.fix.submit", { count: chosen.length })}
              </ActionButton>
              {!saved && <span className="text-faint">{t("corrections.preview.saveFirst")}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
