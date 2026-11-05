import { useTranslation } from "../../i18n";
import { ActionButton } from "../../ui/primitives";
import type { CorrectionDraft } from "./useCorrectionDraft";
import { issueText } from "./issues";

/** Shown only while the draft has unsaved changes; sticks to the bottom of the scrolling area. */
export function SaveBar({ draft }: { draft: CorrectionDraft }) {
  const { t } = useTranslation();
  if (!draft.dirty) return null;
  const blocked = draft.errors.length > 0;
  return (
    <div className="sticky bottom-0 z-10 -mx-1 space-y-2 rounded-md border border-border bg-surface p-3 shadow-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-xs text-muted">
          {blocked
            ? t("settings.corrections.fixBeforeSaving", { count: draft.errors.length })
            : t("settings.corrections.unsaved")}
        </span>
        <ActionButton variant="ghost" size="sm" onClick={draft.discard}>
          {t("settings.corrections.discard")}
        </ActionButton>
        <ActionButton size="sm" onClick={() => void draft.save()} disabled={blocked} busy={draft.saving}>
          {t("settings.corrections.save")}
        </ActionButton>
      </div>
      {blocked && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-danger">
          {draft.errors.map((issue) => {
            const text = issueText(issue, t);
            return <li key={text}>{text}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
