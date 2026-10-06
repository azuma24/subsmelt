import { useTranslation } from "react-i18next";
import type { TaskStatus } from "../../types";
import { Icon } from "../../ui/Icon";
import { languageState, type LanguageState } from "./library-model";
import { languageStatusDisplay } from "./task-status";

export const LANGUAGE_TONE: Record<LanguageState, string> = {
  done: "border-transparent bg-success-soft text-success",
  missing: "border-dashed border-border text-muted",
  queued: "border-transparent bg-warning-soft text-warning",
  translating: "border-transparent bg-accent-soft text-accent",
  error: "border-transparent bg-danger-soft text-danger",
};

/** A target language and its status. The glyph is the only status cue, so it carries the label. */
export function LanguageChip({ task, status }: { task: TaskStatus; status: string }) {
  const { t } = useTranslation();
  const { icon, labelKey } = languageStatusDisplay(task, status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full h-5 border px-2 font-mono text-xs ${LANGUAGE_TONE[languageState(status)]}`}
    >
      {icon && <Icon name={icon} label={labelKey ? t(labelKey) : status} />}
      {task.langCode}
    </span>
  );
}
