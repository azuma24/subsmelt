import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useTasksQuery, useMutationWithInvalidation, useIsMobile } from "../../hooks";
import { getErrorMessage } from "../../lib";
import type { Task } from "../../types";
import { useToast } from "../../ui/Toast";
import { useConfirm } from "../../ui/ConfirmModal";
import { ModalShell } from "../../ui/ModalShell";
import { PRESETS } from "../../app/constants";
import { Accordion, ActionButton, EmptyHint, Field, RowActionsMenu, SelectionBar, PageHeader, TextArea } from "../../ui/primitives";
import {
  AUTO_SOURCE_LANG,
  DEFAULT_OUTPUT_PATTERN,
  LANGUAGE_OPTIONS,
  OUTPUT_FORMATS,
  applyOutputFormat,
  applyTranslationPreset,
  createDefaultTranslationDraft,
  inferOutputFormat,
  type OutputFormat,
} from "./translation-defaults";
import { Icon } from "../../ui/Icon";

interface UpdateTaskVars {
  id: number;
  payload: Partial<Task>;
}

export function TranslationLanguagesPage() {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const tasksQuery = useTasksQuery();
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [showPromptOverride, setShowPromptOverride] = useState(false);
  const [selectedOutputFormat, setSelectedOutputFormat] = useState<OutputFormat>("srt");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set());
  const createMutation = useMutationWithInvalidation<Task, Partial<Task>>((payload) => api.createTask(payload));
  const updateMutation = useMutationWithInvalidation<Task, UpdateTaskVars>(({ id, payload }) => api.updateTask(id, payload));
  const deleteMutation = useMutationWithInvalidation<unknown, number>((id) => api.deleteTask(id));

  const tasks = tasksQuery.data || [];
  const selectedTasks = tasks.filter((task) => selectedTaskIds.has(task.id));

  const handleSave = async () => {
    if (!editing || !editing.target_lang || !editing.lang_code) return;
    const normalizedOutputPattern = applyOutputFormat(editing.output_pattern, selectedOutputFormat);
    const sourceLang = editing.source_lang || AUTO_SOURCE_LANG;
    try {
      if (isNew) {
        const created = await createMutation.mutateAsync({ source_lang: sourceLang, target_lang: editing.target_lang, output_pattern: normalizedOutputPattern, lang_code: editing.lang_code });
        // Use the created task's own id — picking the "newest" by array position
        // races with any concurrent create and could tag the wrong task. The
        // create endpoint ignores prompt_override, so it goes in a follow-up
        // update that also refreshes the list (a stale card would drop the
        // prompt on the next edit).
        if (editing.prompt_override && created?.id) {
          await updateMutation.mutateAsync({ id: created.id, payload: { prompt_override: editing.prompt_override } });
        }
        addToast(t("translation_languages.toast.created", { lang: editing.target_lang }), "success");
      } else if (editing.id) {
        await updateMutation.mutateAsync({ id: editing.id, payload: { ...editing, source_lang: sourceLang, output_pattern: normalizedOutputPattern } });
        addToast(t("translation_languages.toast.updated"), "success");
      }
    } catch (e: unknown) {
      addToast(t("translation_languages.toast.saveFailed", { message: getErrorMessage(e) }), "error");
      return;
    }
    setEditing(null);
    setIsNew(false);
    setShowPromptOverride(false);
  };

  const handleDelete = async (task: Task) => {
    const ok = await confirm({ title: t("translation_languages.confirm.deleteTitle"), message: t("translation_languages.confirm.deleteMessage", { lang: task.target_lang }), confirmLabel: t("translation_languages.confirm.deleteConfirm"), danger: true });
    if (ok) {
      await deleteMutation.mutateAsync(task.id);
      addToast(t("translation_languages.toast.deleted"), "info");
      setSelectedTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  const openNew = (preset?: typeof PRESETS[number]) => {
    const draft = createDefaultTranslationDraft(preset);
    const output_pattern = draft.output_pattern || DEFAULT_OUTPUT_PATTERN;
    setEditing(draft);
    setSelectedOutputFormat(inferOutputFormat(output_pattern));
    setIsNew(true);
    setShowPromptOverride(false);
  };

  const openEdit = (task: Task) => {
    setEditing({ ...task });
    setSelectedOutputFormat(inferOutputFormat(task.output_pattern));
    setIsNew(false);
    setShowPromptOverride(!!task.prompt_override);
  };

  const toggleTaskSelected = (id: number) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyBulk = async (payload: Partial<Task>) => {
    if (selectedTasks.length === 0) return;
    try {
      await Promise.all(selectedTasks.map((task) => api.updateTask(task.id, payload)));
      addToast(t("translation_languages.toast.bulkUpdated", { count: selectedTasks.length }), "success");
      await tasksQuery.refetch();
    } catch (e) {
      addToast(e instanceof Error ? e.message : t("translation_languages.toast.bulkUpdateFailed"), "error");
    }
  };

  const applyBulkFormat = async (format: OutputFormat) => {
    if (selectedTasks.length === 0) return;
    try {
      await Promise.all(selectedTasks.map((task) => api.updateTask(task.id, { output_pattern: applyOutputFormat(task.output_pattern, format) })));
      addToast(t("translation_languages.toast.bulkFormatUpdated", { count: selectedTasks.length, format }), "success");
      await tasksQuery.refetch();
    } catch (e) {
      addToast(e instanceof Error ? e.message : t("translation_languages.toast.bulkUpdateFailed"), "error");
    }
  };

  const clearSelection = () => setSelectedTaskIds(new Set());

  const langCodeError = editing?.lang_code && /[^a-zA-Z0-9\-_]/.test(editing.lang_code) ? t("translation_languages.langCodeError") : "";
  const patternError = editing?.output_pattern && !editing.output_pattern.includes("{{name}}") ? t("translation_languages.patternError") : "";
  const canSave = editing?.target_lang && editing?.lang_code && !langCodeError && !patternError;
  const patternFormat = inferOutputFormat(editing?.output_pattern);
  const hasMismatch = !!editing && !editing.output_pattern?.includes("{{ext}}") && patternFormat !== selectedOutputFormat;
  const previewExample = editing?.output_pattern
    ? applyOutputFormat(editing.output_pattern, selectedOutputFormat)
        .replace("{{name}}", "The.Matrix.1999")
        .replace("{{lang_code}}", editing.lang_code || "xx")
        .replaceAll("{{ext}}", selectedOutputFormat)
    : "";
  const modalLanguageOptions = useMemo(() => {
    if (!editing?.lang_code || LANGUAGE_OPTIONS.some((option) => option.value === editing.lang_code)) return LANGUAGE_OPTIONS;
    return [
      {
        value: editing.lang_code,
        label: `${editing.target_lang || editing.lang_code} · ${editing.lang_code}`,
        targetLang: editing.target_lang || editing.lang_code,
        outputPattern: editing.output_pattern || DEFAULT_OUTPUT_PATTERN,
      },
      ...LANGUAGE_OPTIONS,
    ];
  }, [editing?.lang_code, editing?.output_pattern, editing?.target_lang]);

  const bulkCounts = useMemo(() => ({
    enabled: selectedTasks.filter((x) => x.enabled === 1).length,
    disabled: selectedTasks.filter((x) => x.enabled !== 1).length,
  }), [selectedTasks]);

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={t("translation_languages.title")}
        actions={<ActionButton size="sm" onClick={() => openNew()}>{t("translation_languages.addLanguage")}</ActionButton>}
      />

      <div className="flex-1 space-y-4 p-4 md:p-4">
        {/* Presets → "Quick add" collapsed accordion (L3) */}
        <Accordion title={t("translation_languages.quickAdd")}>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const exists = tasks.some((task) => task.lang_code === p.lang_code);
              return (
                <button
                  key={p.lang_code}
                  onClick={() => !exists && openNew(p)}
                  disabled={exists}
                  className={`rounded-full px-3 py-2 text-xs font-medium ${exists ? "bg-surface-raised text-faint" : "bg-surface-raised text-muted hover:bg-surface-highlight hover:text-text"}`}
                >
                  {p.label} {exists && <Icon name="done" />}
                </button>
              );
            })}
          </div>
        </Accordion>

        {/* Bulk selection bar — appears only when tasks selected */}
        <SelectionBar
          count={selectedTasks.length}
          summaryLabel={t("translation_languages.bulk.title", { count: selectedTasks.length })}
          onClear={clearSelection}
          clearLabel={t("translation_languages.bulk.clearSelection")}
        >
          <button onClick={() => applyBulk({ enabled: 1 })} disabled={bulkCounts.disabled === 0} className="rounded-sm bg-success px-3 py-2 text-xs font-semibold text-accent-text disabled:opacity-40">{t("translation_languages.bulk.enable")}</button>
          <button onClick={() => applyBulk({ enabled: 0 })} disabled={bulkCounts.enabled === 0} className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-xs text-text disabled:opacity-40">{t("translation_languages.bulk.disable")}</button>
          {OUTPUT_FORMATS.map((format) => (
            <button key={format} onClick={() => applyBulkFormat(format)} className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-xs uppercase text-muted hover:text-text">{t("translation_languages.bulk.setFormat", { format })}</button>
          ))}
        </SelectionBar>

        {/* Task grid — cards show Source→Target + enabled toggle + custom-prompt chip */}
        <section className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {tasks.map((task) => (
            <div key={task.id} className={`rounded-md border px-3 py-4 ${task.enabled ? "border-border bg-surface" : "border-border bg-surface opacity-60"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <input type="checkbox" aria-label={task.target_lang} checked={selectedTaskIds.has(task.id)} onChange={() => toggleTaskSelected(task.id)} className="mt-1 h-4 w-4 accent-accent" />
                  <div className="min-w-0 flex-1">
                    {/* L1: Source → Target */}
                    <div className="flex items-center gap-2 text-sm font-medium text-text">
                      <span>{task.source_lang}</span>
                      <span className="text-faint">→</span>
                      <span>{task.target_lang}</span>
                    </div>
                    {/* L2: custom-prompt chip */}
                    {task.prompt_override && (
                      <div className="mt-2 text-xs text-accent">{t("translation_languages.customPrompt")}</div>
                    )}
                    {/* L3: output pattern hidden by default — visible in edit modal */}
                    {/* L4: lang code hidden — visible in edit modal */}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {/* Enabled toggle */}
                  <button
                    onClick={() => updateMutation.mutate({ id: task.id, payload: { enabled: task.enabled ? 0 : 1 } })}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${task.enabled ? "border-success-line bg-success-soft text-success" : "border-border bg-surface-raised text-faint"}`}
                  >
                    {task.enabled ? t("translation_languages.enabled") : t("translation_languages.disabled")}
                  </button>
                  {/* Edit stays inline (≤2 clicks); Delete → overflow menu */}
                  <div className="flex items-center gap-2">
                    <ActionButton size="sm" variant="ghost" onClick={() => openEdit(task)}>{t("translation_languages.edit")}</ActionButton>
                    <RowActionsMenu
                      items={[
                        {
                          label: t("translation_languages.delete"),
                          danger: true,
                          onClick: () => handleDelete(task),
                        },
                      ]}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
          {tasks.length === 0 && <div className="col-span-full"><EmptyHint text={t("translation_languages.noTasks")} subtext={t("translation_languages.noTasksHint")} /></div>}
        </section>
      </div>

      {editing && (
        <ModalShell
          title={isNew ? t("translation_languages.addModal") : t("translation_languages.editModal")}
          onClose={() => { setEditing(null); setIsNew(false); }}
          overlayClassName="fixed inset-0 z-50 bg-scrim p-0 md:p-4"
          panelClassName={`mx-auto flex w-full flex-col border border-border bg-surface ${isMobile ? "h-full overflow-y-auto rounded-none p-4" : "mt-8 max-w-xl rounded-md p-6"}`}
        >
          <div className="mt-4 space-y-4">
                <div className="rounded-sm border border-border bg-surface-raised p-3">
                  <div className="mb-1 text-sm font-medium text-muted">{t("translation_languages.sourceLang")}</div>
                  <div className="inline-flex rounded-full border border-accent-line bg-accent-soft px-3 py-1 text-sm font-semibold text-accent">{t("translation_languages.sourceAutoBadge")}</div>
                  <p className="mt-2 text-xs text-faint">{t("translation_languages.sourceAutoHelp")}</p>
                </div>
                <SelectField
                  label={t("translation_languages.targetLang")}
                  value={editing.lang_code || ""}
                  onChange={(langCode) => {
                    const next = applyTranslationPreset(editing, langCode);
                    setEditing(next);
                    setSelectedOutputFormat(inferOutputFormat(next.output_pattern));
                  }}
                  options={modalLanguageOptions.map((option) => ({ value: option.value, label: option.targetLang }))}
                  required
                />
                <SelectField
                  label={t("translation_languages.langCode")}
                  value={editing.lang_code || ""}
                  onChange={(langCode) => {
                    const next = applyTranslationPreset(editing, langCode);
                    setEditing(next);
                    setSelectedOutputFormat(inferOutputFormat(next.output_pattern));
                  }}
                  options={modalLanguageOptions.map((option) => ({ value: option.value, label: option.label }))}
                  help={t("translation_languages.langCodeHelp")}
                  required
                />
                <div>
                  <div className="mb-2 text-sm font-medium text-muted">{t("translation_languages.outputFormat")}</div>
                  <div className="flex flex-wrap gap-2">
                    {OUTPUT_FORMATS.map((format) => {
                      const active = selectedOutputFormat === format;
                      return (
                        <button
                          key={format}
                          onClick={() => {
                            setSelectedOutputFormat(format);
                            setEditing({ ...editing, output_pattern: applyOutputFormat(editing.output_pattern, format) });
                          }}
                          className={`rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-wide ${active ? "bg-accent text-accent-text" : "bg-surface-raised text-muted hover:bg-surface-highlight hover:text-text"}`}
                        >
                          {format}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-xs text-faint">{t("translation_languages.outputFormatHelp")}</p>
                </div>
                {hasMismatch && (
                  <div className="rounded-sm border border-warning-line bg-warning-soft p-3 text-xs text-warning">
                    {t("translation_languages.formatMismatch", { selected: selectedOutputFormat, detected: patternFormat })}
                    <div>
                      <button onClick={() => setEditing({ ...editing, output_pattern: applyOutputFormat(editing.output_pattern, selectedOutputFormat) })} className="mt-2 rounded-sm bg-warning px-2 py-1 font-medium text-accent-text">
                        {t("translation_languages.fixPattern")}
                      </button>
                    </div>
                  </div>
                )}
                <Field label={t("translation_languages.outputPattern")} value={editing.output_pattern || ""} onChange={(v) => setEditing({ ...editing, output_pattern: v })} placeholder="{{name}}.{{lang_code}}.srt" error={patternError} help={t("translation_languages.patternHelp")} />
                <div>
                  <button onClick={() => setEditing({ ...editing, output_pattern: `{{name}}.{{lang_code}}.${selectedOutputFormat}` })} className="rounded-sm border border-border bg-surface-raised px-2 py-1 text-xs text-muted">
                    {t("translation_languages.resetRecommended")}
                  </button>
                </div>
                {previewExample && <div className="rounded-sm bg-surface-raised p-3 text-xs font-mono"><div className="text-faint">{t("translation_languages.previewSource")} <span className="text-muted">The.Matrix.1999.srt</span></div><div className="mt-1 text-faint">{t("translation_languages.previewOutput")} <span className="text-success">{previewExample}</span></div></div>}
                {!showPromptOverride ? <button onClick={() => setShowPromptOverride(true)} className="text-xs text-accent">{t("translation_languages.addPromptOverride")}</button> : <div><div className="mb-1 flex items-center justify-between"><label className="text-sm font-medium text-muted">{t("translation_languages.promptOverride")}</label><button onClick={() => { setShowPromptOverride(false); setEditing({ ...editing, prompt_override: "" }); }} className="text-xs text-faint">{t("translation_languages.removePromptOverride")}</button></div><TextArea value={editing.prompt_override || ""} onChange={(value) => setEditing({ ...editing, prompt_override: value })} rows={5} placeholder={t("translation_languages.promptOverridePlaceholder")} mono /><p className="mt-1 text-xs text-faint">{t("translation_languages.promptOverrideHint")}</p></div>}
          </div>
          <div className={`mt-6 flex gap-3 ${isMobile ? "sticky bottom-0 bg-surface pt-4" : "justify-end"}`}>
            <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-3 text-sm text-muted md:flex-none">{t("common.cancel")}</button>
            <button onClick={handleSave} disabled={!canSave} className="flex-1 rounded-sm bg-accent px-4 py-3 text-sm font-medium text-accent-text disabled:opacity-50 md:flex-none">{isNew ? t("translation_languages.create") : t("common.save")}</button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

interface SelectFieldOption {
  value: string;
  label: string;
}

function SelectField({ label, value, onChange, options, help, required }: { label: string; value: string; onChange: (v: string) => void; options: SelectFieldOption[]; help?: string; required?: boolean }) {
  const selectId = useId();
  const helpId = `${selectId}-help`;

  return (
    <div>
      <label htmlFor={selectId} className="mb-2 block text-xs font-medium text-muted">
        {label} {required && <span className="text-danger">*</span>}
      </label>
      <select
        id={selectId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={help ? helpId : undefined}
        required={required}
        className="w-full rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm leading-6 text-text focus:border-accent"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {help && <p id={helpId} className="mt-1 text-xs leading-6 text-faint">{help}</p>}
    </div>
  );
}
