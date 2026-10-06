import { useMemo } from "react";
import { useTranslation } from "../../../i18n";
import type { Task } from "../../../types";
import { Accordion } from "../../../ui/primitives";
import {
  TRI_STATES,
  createRuleId,
  parseDirectoryRules,
  serializeDirectoryRules,
  type DirectoryRule,
  type TriState,
} from "./model";

/**
 * Per-directory overrides (videoless handling + which target languages apply).
 *
 * Wrapped in an `Accordion` so it no longer competes for attention with the
 * folder tree above it — the whole editor used to render inline and expanded,
 * making Sources the tallest screen in the app. Adding a rule is now
 * open-then-click: two clicks, the budget the audit allows.
 */
export function DirectoryRulesSection({
  folders,
  rawRules,
  onChange,
  tasks,
}: {
  folders: string[];
  rawRules: string;
  onChange: (rules: string) => void;
  tasks: Task[];
}) {
  const { t } = useTranslation();

  const rules = useMemo(() => parseDirectoryRules(rawRules), [rawRules]);

  const commit = (next: DirectoryRule[]) => onChange(serializeDirectoryRules(next));

  const addRule = () => {
    // Pick the first folder (incl. root "") that doesn't already have a rule, so
    // clicking Add twice can't create two rules for the same path.
    const taken = new Set(rules.map((r) => r.path));
    const path = ["", ...folders].find((p) => !taken.has(p));
    if (path === undefined) return;
    commit([...rules, { id: createRuleId(), path, enabled: true, translateWithoutVideo: "on", taskIds: [] }]);
  };

  const updateRule = (id: string, patch: Partial<DirectoryRule>) => {
    commit(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRule = (id: string) => commit(rules.filter((r) => r.id !== id));

  const toggleTask = (rule: DirectoryRule, taskId: number) => {
    const taskIds = rule.taskIds.includes(taskId)
      ? rule.taskIds.filter((n) => n !== taskId)
      : [...rule.taskIds, taskId];
    updateRule(rule.id, { taskIds });
  };

  const triLabel = (state: TriState): string => t(`settings.sources.dirRules.tri_${state}`);

  return (
    <Accordion title={t("settings.sources.dirRules.title")} defaultOpen={rules.length > 0}>
      <div className="space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <p className="text-xs text-faint">{t("settings.sources.dirRules.hint")}</p>
          <button
            type="button"
            onClick={addRule}
            className="shrink-0 rounded-sm bg-accent px-3 py-2 text-xs font-medium text-accent-text min-h-touch md:min-h-0"
          >
            {t("settings.sources.dirRules.addRule")}
          </button>
        </div>

        {rules.length === 0 ? (
          <p className="text-xs text-faint">{t("settings.sources.dirRules.noRules")}</p>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => (
              <div key={rule.id} className="rounded-sm border border-border bg-surface-raised p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                      className="h-4 w-4 accent-accent"
                    />
                    {t("settings.sources.dirRules.enabled")}
                  </label>
                  <select
                    value={rule.path}
                    aria-label={t("settings.sources.dirRules.title")}
                    onChange={(e) => updateRule(rule.id, { path: e.target.value })}
                    className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 py-2 text-xs text-text focus:border-accent min-h-touch md:min-h-0"
                  >
                    <option value="">{t("settings.sources.dirRules.allFolders")}</option>
                    {folders.map((folder) => (
                      <option key={folder} value={folder}>
                        {folder}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeRule(rule.id)}
                    className="rounded-sm px-2 py-1 text-xs text-faint hover:text-danger"
                  >
                    {t("common.delete")}
                  </button>
                </div>

                <div className="mb-2">
                  <div className="mb-1 text-xs uppercase tracking-wide text-faint">
                    {t("settings.sources.dirRules.videolessLabel")}
                  </div>
                  <div className="inline-flex overflow-hidden rounded-sm border border-border">
                    {TRI_STATES.map((state) => (
                      <button
                        key={state}
                        type="button"
                        onClick={() => updateRule(rule.id, { translateWithoutVideo: state })}
                        aria-pressed={rule.translateWithoutVideo === state}
                        className={`px-3 py-1 text-xs ${rule.translateWithoutVideo === state ? "bg-accent text-accent-text" : "bg-surface-raised text-muted hover:text-text"}`}
                      >
                        {triLabel(state)}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-faint">
                    {t("settings.sources.dirRules.languagesLabel")}
                  </div>
                  {tasks.length === 0 ? (
                    <p className="text-xs text-faint">{t("settings.sources.dirRules.noTasks")}</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {tasks.map((task) => (
                        <label
                          key={task.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-xs ${rule.taskIds.includes(task.id) ? "border-accent-line bg-accent-soft text-accent" : "border-border bg-surface-raised text-muted"}`}
                        >
                          <input
                            type="checkbox"
                            checked={rule.taskIds.includes(task.id)}
                            onChange={() => toggleTask(rule, task.id)}
                            className="h-3 w-3 accent-accent"
                          />
                          {task.target_lang}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Accordion>
  );
}
