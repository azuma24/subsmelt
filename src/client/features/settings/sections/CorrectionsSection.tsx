import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import * as api from "../../../api";
import type { Task } from "../../../types";
import { ActionButton, Checkbox, Field, Select } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { createRuleId, flattenFolderTree } from "../media-sources/model";
import {
  CORRECTION_MATCH_MODES,
  CORRECTION_STAGES,
  compileCorrectionsFor,
  correctCueText,
  correctionRuleError,
  correctionRuleSetsErrors,
  parseCorrectionRuleSets,
  totalCorrections,
  type CorrectionRule,
  type CorrectionRuleSet,
} from "../../../../shared/corrections";
import { labelCls } from "./shared";

interface CorrectionsSectionProps {
  settings: Record<string, unknown>;
  updateAndSave: (key: string, value: unknown) => Promise<void> | void;
}

const SMALL_CONTROL =
  "rounded-sm border border-border bg-surface px-2 py-2 text-xs text-text focus:border-accent min-h-touch md:min-h-0";

function newRule(): CorrectionRule {
  return {
    id: createRuleId(),
    find: "",
    replace: "",
    stage: "source",
    match: "word",
    caseSensitive: true,
    languages: [],
    enabled: true,
  };
}

function newSet(name: string): CorrectionRuleSet {
  return { id: createRuleId(), name, enabled: true, paths: [], rules: [newRule()] };
}

/**
 * Subtitle Corrections: find → replace rule sets, each scoped to media
 * folders. Unlike the rest of Settings this editor keeps a local draft and
 * saves on demand: the page saves every setting in one request and the server
 * refuses the whole request over one invalid rule, so a half-typed regex must
 * never reach an autosave.
 */
export function CorrectionsSection({ settings, updateAndSave }: CorrectionsSectionProps) {
  const { t } = useTranslation();
  const saved = str(settings.correction_rule_sets, "[]");
  const [draft, setDraft] = useState<CorrectionRuleSet[]>(() => parseCorrectionRuleSets(saved));
  const [savedSnapshot, setSavedSnapshot] = useState(saved);
  const [folders, setFolders] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [saving, setSaving] = useState(false);

  // Settings arrive after the first render (and change after a save): follow them while nothing is being edited.
  const serialized = JSON.stringify(draft);
  const dirty = serialized !== JSON.stringify(parseCorrectionRuleSets(savedSnapshot));
  useEffect(() => {
    if (saved === savedSnapshot) return;
    if (!dirty) setDraft(parseCorrectionRuleSets(saved));
    setSavedSnapshot(saved);
  }, [saved, savedSnapshot, dirty]);

  useEffect(() => {
    let active = true;
    api
      .getFolderTree()
      .then((data) => active && setFolders(flattenFolderTree(data.root.children)))
      .catch(() => active && setFolders([]));
    api
      .getTasks()
      .then((data) => active && setTasks(data))
      .catch(() => active && setTasks([]));
    return () => {
      active = false;
    };
  }, []);

  const errors = useMemo(() => correctionRuleSetsErrors(serialized), [serialized]);
  const langCodes = useMemo(() => Array.from(new Set(tasks.map((task) => task.lang_code))).sort(), [tasks]);

  const updateSet = (id: string, patch: Partial<CorrectionRuleSet>) =>
    setDraft((sets) => sets.map((set) => (set.id === id ? { ...set, ...patch } : set)));
  const updateRule = (set: CorrectionRuleSet, ruleId: string, patch: Partial<CorrectionRule>) =>
    updateSet(set.id, { rules: set.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)) });

  const save = async () => {
    if (errors.length) return;
    setSaving(true);
    try {
      await updateAndSave("correction_rule_sets", serialized);
    } finally {
      setSaving(false);
    }
  };

  const stageLabel = (stage: string) => t(`settings.corrections.stage_${stage}`);
  const matchLabel = (match: string) => t(`settings.corrections.match_${match}`);

  return (
    <div className="space-y-4">
      <p className="text-xs leading-6 text-faint">{t("settings.corrections.hint")}</p>

      {draft.length === 0 && <p className="text-xs text-faint">{t("settings.corrections.noSets")}</p>}

      {draft.map((set) => (
        <div key={set.id} className="space-y-3 rounded-sm border border-border bg-surface-raised p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1">
              <Field
                label={t("settings.corrections.setName")}
                value={set.name}
                onChange={(name) => updateSet(set.id, { name })}
                placeholder={t("settings.corrections.setNamePlaceholder")}
              />
            </div>
            <Checkbox
              label={t("settings.corrections.enabled")}
              checked={set.enabled}
              onChange={(enabled) => updateSet(set.id, { enabled })}
              className="pb-2"
            />
            <button
              type="button"
              onClick={() => setDraft((sets) => sets.filter((s) => s.id !== set.id))}
              className="rounded-sm px-2 py-2 text-xs text-faint hover:text-danger"
            >
              {t("settings.corrections.deleteSet")}
            </button>
          </div>

          <div>
            <span className={labelCls}>{t("settings.corrections.folders")}</span>
            <div className="flex flex-wrap items-center gap-2">
              {set.paths.map((folder) => (
                <span
                  key={folder}
                  className="inline-flex items-center gap-1 rounded-full border border-accent-line bg-accent-soft px-3 py-1 text-xs text-accent"
                >
                  {folder === "" ? t("settings.corrections.wholeLibrary") : folder}
                  <button
                    type="button"
                    aria-label={t("common.delete")}
                    onClick={() => updateSet(set.id, { paths: set.paths.filter((p) => p !== folder) })}
                    className="text-faint hover:text-danger"
                  >
                    ×
                  </button>
                </span>
              ))}
              <select
                value=""
                aria-label={t("settings.corrections.addFolder")}
                onChange={(e) => {
                  const folder = e.target.value;
                  if (folder === "__none") return;
                  if (!set.paths.includes(folder)) updateSet(set.id, { paths: [...set.paths, folder] });
                }}
                className={`min-w-0 max-w-full ${SMALL_CONTROL}`}
              >
                <option value="__none">{t("settings.corrections.addFolder")}</option>
                <option value="">{t("settings.corrections.wholeLibrary")}</option>
                {folders
                  .filter((folder) => !set.paths.includes(folder))
                  .map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <span className={labelCls}>{t("settings.corrections.rules")}</span>
            {set.rules.map((rule) => {
              const error = rule.find ? correctionRuleError(rule) : null;
              return (
                <div key={rule.id} className="space-y-2 rounded-sm border border-border bg-surface p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      aria-label={t("settings.corrections.enabled")}
                      onChange={(e) => updateRule(set, rule.id, { enabled: e.target.checked })}
                      className="h-4 w-4 accent-accent"
                    />
                    <input
                      value={rule.find}
                      onChange={(e) => updateRule(set, rule.id, { find: e.target.value })}
                      placeholder={t("settings.corrections.find")}
                      aria-label={t("settings.corrections.find")}
                      aria-invalid={Boolean(error)}
                      className={`min-w-[120px] flex-1 font-mono ${SMALL_CONTROL}`}
                    />
                    <span className="text-xs text-faint">→</span>
                    <input
                      value={rule.replace}
                      onChange={(e) => updateRule(set, rule.id, { replace: e.target.value })}
                      placeholder={t("settings.corrections.replace")}
                      aria-label={t("settings.corrections.replace")}
                      className={`min-w-[120px] flex-1 font-mono ${SMALL_CONTROL}`}
                    />
                    <button
                      type="button"
                      onClick={() => updateSet(set.id, { rules: set.rules.filter((r) => r.id !== rule.id) })}
                      className="rounded-sm px-2 py-1 text-xs text-faint hover:text-danger"
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={rule.stage}
                      aria-label={t("settings.corrections.stage")}
                      onChange={(e) => updateRule(set, rule.id, { stage: e.target.value as CorrectionRule["stage"] })}
                      className={SMALL_CONTROL}
                    >
                      {CORRECTION_STAGES.map((stage) => (
                        <option key={stage} value={stage}>
                          {stageLabel(stage)}
                        </option>
                      ))}
                    </select>
                    <select
                      value={rule.match}
                      aria-label={t("settings.corrections.match")}
                      onChange={(e) => updateRule(set, rule.id, { match: e.target.value as CorrectionRule["match"] })}
                      className={SMALL_CONTROL}
                    >
                      {CORRECTION_MATCH_MODES.map((match) => (
                        <option key={match} value={match}>
                          {matchLabel(match)}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-2 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={rule.caseSensitive}
                        onChange={(e) => updateRule(set, rule.id, { caseSensitive: e.target.checked })}
                        className="h-4 w-4 accent-accent"
                      />
                      {t("settings.corrections.caseSensitive")}
                    </label>
                    {rule.stage !== "source" && langCodes.length > 0 && (
                      <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
                        {t("settings.corrections.languages")}
                        {langCodes.map((code) => {
                          const on = rule.languages.includes(code.toLowerCase());
                          return (
                            <button
                              key={code}
                              type="button"
                              aria-pressed={on}
                              onClick={() =>
                                updateRule(set, rule.id, {
                                  languages: on
                                    ? rule.languages.filter((l) => l !== code.toLowerCase())
                                    : [...rule.languages, code.toLowerCase()],
                                })
                              }
                              className={`rounded-full border px-2 py-0.5 ${on ? "border-accent-line bg-accent-soft text-accent" : "border-border text-muted"}`}
                            >
                              {code}
                            </button>
                          );
                        })}
                        {rule.languages.length === 0 && (
                          <span className="text-faint">({t("settings.corrections.allLanguages")})</span>
                        )}
                      </span>
                    )}
                  </div>
                  {error && <p className="text-xs text-danger">{error}</p>}
                </div>
              );
            })}
            <ActionButton
              variant="ghost"
              size="sm"
              onClick={() => updateSet(set.id, { rules: [...set.rules, newRule()] })}
            >
              {t("settings.corrections.addRule")}
            </ActionButton>
          </div>

          <TryLine set={set} />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          variant="ghost"
          size="sm"
          onClick={() => setDraft((sets) => [...sets, newSet(t("settings.corrections.newSetName"))])}
        >
          {t("settings.corrections.addSet")}
        </ActionButton>
        <ActionButton size="sm" onClick={save} disabled={!dirty || errors.length > 0} busy={saving}>
          {t("settings.corrections.save")}
        </ActionButton>
        {dirty && (
          <ActionButton variant="ghost" size="sm" onClick={() => setDraft(parseCorrectionRuleSets(savedSnapshot))}>
            {t("settings.corrections.discard")}
          </ActionButton>
        )}
      </div>
      {dirty && errors.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-danger">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Runs the set's rules on a typed line, with the same code the server uses. */
function TryLine({ set }: { set: CorrectionRuleSet }) {
  const { t } = useTranslation();
  const [line, setLine] = useState("");
  const [stage, setStage] = useState<"source" | "output">("source");
  const result = useMemo(() => {
    // Every rule of the stage, whatever its folders and languages: this previews the set itself.
    const preview = {
      ...set,
      enabled: true,
      paths: [""],
      rules: set.rules.map((rule) => ({ ...rule, languages: [] })),
    };
    return correctCueText(line, compileCorrectionsFor([preview], "", stage));
  }, [set, line, stage]);
  const count = totalCorrections(result.counts);
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[200px] flex-1">
          <Field
            label={t("settings.corrections.tryLine")}
            value={line}
            onChange={setLine}
            placeholder={t("settings.corrections.tryLinePlaceholder")}
          />
        </div>
        <div className="w-[200px]">
          <Select
            ariaLabel={t("settings.corrections.stage")}
            value={stage}
            onChange={(value) => setStage(value as "source" | "output")}
          >
            <option value="source">{t("settings.corrections.stage_source")}</option>
            <option value="output">{t("settings.corrections.stage_output")}</option>
          </Select>
        </div>
      </div>
      {line && (
        <p className="break-words font-mono text-xs text-muted">
          → {result.text} <span className="text-faint">({t("settings.corrections.replacements", { count })})</span>
        </p>
      )}
    </div>
  );
}
