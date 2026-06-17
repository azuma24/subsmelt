import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useTasksQuery, useMutationWithInvalidation } from "../../hooks";
import type { Task } from "../../types";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { ModalShell } from "../../components/ModalShell";
import { PRESETS } from "../../app/constants";
import { Accordion, ActionButton, EmptyHint, Field, RowActionsMenu, SelectionBar } from "../../ui/primitives";
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

interface UpdateTaskVars {
  id: number;
  payload: Partial<Task>;
}

export function TranslationLanguagesPage({ isMobile }: { isMobile: boolean }) {
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
    if (isNew) {
      const created = await createMutation.mutateAsync({ source_lang: sourceLang, target_lang: editing.target_lang, output_pattern: normalizedOutputPattern, lang_code: editing.lang_code });
      // Use the created task's own id — picking the "newest" by array position
      // races with any concurrent create and could tag the wrong task.
      if (editing.prompt_override && created?.id) {
        await api.updateTask(created.id, { prompt_override: editing.prompt_override });
      }
      addToast(t("translation_languages.toast.created", { lang: editing.target_lang }), "success");
    } else if (editing.id) {
      await updateMutation.mutateAsync({ id: editing.id, payload: { ...editing, source_lang: sourceLang, output_pattern: normalizedOutputPattern } });
      addToast(t("translation_languages.toast.updated"), "success");
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
    await Promise.all(selectedTasks.map((task) => api.updateTask(task.id, payload)));
    addToast(t("translation_languages.toast.bulkUpdated", { count: selectedTasks.length }), "success");
    tasksQuery.refetch();
  };

  const applyBulkFormat = async (format: OutputFormat) => {
    if (selectedTasks.length === 0) return;
    await Promise.all(selectedTasks.map((task) => api.updateTask(task.id, { output_pattern: applyOutputFormat(task.output_pattern, format) })));
    addToast(t("translation_languages.toast.bulkFormatUpdated", { count: selectedTasks.length, format }), "success");
    tasksQuery.refetch();
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
      {/* Topbar */}
      <div className="sticky top-0 z-30 flex h-[50px] shrink-0 items-center gap-2.5 border-b border-[var(--border)] bg-[var(--surface)] px-3.5 md:px-[18px]">
        <span className="flex-1 text-sm font-semibold text-[var(--text)]">{t("translation_languages.title")}</span>
        <ActionButton size="sm" onClick={() => openNew()}>{t("translation_languages.addLanguage")}</ActionButton>
      </div>

      <div className="flex-1 space-y-4 p-3.5 md:p-[18px]">
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
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${exists ? "bg-[var(--surface-2)] text-[var(--text-3)]" : "bg-[var(--surface-2)] text-[var(--text-2)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"}`}
                >
                  {p.label} {exists && "✓"}
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
          isMobile={isMobile}
        >
          <button onClick={() => applyBulk({ enabled: 1 })} disabled={bulkCounts.disabled === 0} className="rounded-lg bg-[var(--green)] px-3 py-2 text-xs font-semibold text-black disabled:opacity-40">{t("translation_languages.bulk.enable")}</button>
          <button onClick={() => applyBulk({ enabled: 0 })} disabled={bulkCounts.enabled === 0} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text)] disabled:opacity-40">{t("translation_languages.bulk.disable")}</button>
          {OUTPUT_FORMATS.map((format) => (
            <button key={format} onClick={() => applyBulkFormat(format)} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs uppercase text-[var(--text-2)] hover:text-[var(--text)]">{t("translation_languages.bulk.setFormat", { format })}</button>
          ))}
        </SelectionBar>

        {/* Task grid — cards show Source→Target + enabled toggle + custom-prompt chip */}
        <section className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {tasks.map((task) => (
            <div key={task.id} className={`rounded-xl border px-[13px] py-[14px] ${task.enabled ? "border-[var(--border)] bg-[var(--surface)]" : "border-[var(--border)] bg-[var(--surface)] opacity-60"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <input type="checkbox" checked={selectedTaskIds.has(task.id)} onChange={() => toggleTaskSelected(task.id)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                  <div className="min-w-0 flex-1">
                    {/* L1: Source → Target */}
                    <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text)]">
                      <span>{task.source_lang}</span>
                      <span className="text-[var(--text-3)]">→</span>
                      <span>{task.target_lang}</span>
                    </div>
                    {/* L2: custom-prompt chip */}
                    {task.prompt_override && (
                      <div className="mt-1.5 text-[11px] text-[var(--accent)]">{t("translation_languages.customPrompt")}</div>
                    )}
                    {/* L3: output pattern hidden by default — visible in edit modal */}
                    {/* L4: lang code hidden — visible in edit modal */}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {/* Enabled toggle */}
                  <button
                    onClick={() => updateMutation.mutate({ id: task.id, payload: { enabled: task.enabled ? 0 : 1 } })}
                    className={`rounded-full border px-3 py-1 text-[11.5px] font-medium ${task.enabled ? "border-[var(--green-border)] bg-[var(--green-dim)] text-[var(--green)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-3)]"}`}
                  >
                    {task.enabled ? t("translation_languages.enabled") : t("translation_languages.disabled")}
                  </button>
                  {/* Edit stays inline (≤2 clicks); Delete → overflow menu */}
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => openEdit(task)} className="text-[11px] text-[var(--text-2)] hover:text-[var(--text)]">{t("translation_languages.edit")}</button>
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
          overlayClassName="fixed inset-0 z-50 bg-black/70 p-0 md:p-4"
          panelClassName={`mx-auto flex w-full flex-col border border-[var(--border)] bg-[var(--surface)] ${isMobile ? "h-full overflow-y-auto rounded-none p-4" : "mt-8 max-w-xl rounded-xl p-6"}`}
        >
          <div className="mt-4 space-y-4">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                  <div className="mb-1 text-[13px] font-medium text-[var(--text-2)]">{t("translation_languages.sourceLang")}</div>
                  <div className="inline-flex rounded-full border border-[var(--accent-border)] bg-[var(--accent-dim)] px-3 py-1 text-[13px] font-semibold text-[var(--accent)]">{t("translation_languages.sourceAutoBadge")}</div>
                  <p className="mt-2 text-[11px] text-[var(--text-3)]">{t("translation_languages.sourceAutoHelp")}</p>
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
                  <div className="mb-2 text-[13px] font-medium text-[var(--text-2)]">{t("translation_languages.outputFormat")}</div>
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
                          className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wide ${active ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text-2)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"}`}
                        >
                          {format}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--text-3)]">{t("translation_languages.outputFormatHelp")}</p>
                </div>
                {hasMismatch && (
                  <div className="rounded-lg border border-[var(--yellow-border)] bg-[var(--yellow-dim)] p-3 text-xs text-[var(--yellow)]">
                    {t("translation_languages.formatMismatch", { selected: selectedOutputFormat, detected: patternFormat })}
                    <div>
                      <button onClick={() => setEditing({ ...editing, output_pattern: applyOutputFormat(editing.output_pattern, selectedOutputFormat) })} className="mt-2 rounded-lg bg-[var(--yellow)] px-2 py-1 font-medium text-black">
                        {t("translation_languages.fixPattern")}
                      </button>
                    </div>
                  </div>
                )}
                <Field label={t("translation_languages.outputPattern")} value={editing.output_pattern || ""} onChange={(v) => setEditing({ ...editing, output_pattern: v })} placeholder="{{name}}.{{lang_code}}.srt" error={patternError} help={t("translation_languages.patternHelp")} />
                <div>
                  <button onClick={() => setEditing({ ...editing, output_pattern: `{{name}}.{{lang_code}}.${selectedOutputFormat}` })} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[11px] text-[var(--text-2)]">
                    {t("translation_languages.resetRecommended")}
                  </button>
                </div>
                {previewExample && <div className="rounded-lg bg-[var(--surface-2)] p-3 text-xs font-mono"><div className="text-[var(--text-3)]">{t("translation_languages.previewSource")} <span className="text-[var(--text-2)]">The.Matrix.1999.srt</span></div><div className="mt-1 text-[var(--text-3)]">{t("translation_languages.previewOutput")} <span className="text-[var(--green)]">{previewExample}</span></div></div>}
                {!showPromptOverride ? <button onClick={() => setShowPromptOverride(true)} className="text-xs text-[var(--accent)]">{t("translation_languages.addPromptOverride")}</button> : <div><div className="mb-1 flex items-center justify-between"><label className="text-[13px] font-medium text-[var(--text-2)]">{t("translation_languages.promptOverride")}</label><button onClick={() => { setShowPromptOverride(false); setEditing({ ...editing, prompt_override: "" }); }} className="text-[11px] text-[var(--text-3)]">{t("translation_languages.removePromptOverride")}</button></div><textarea value={editing.prompt_override || ""} onChange={(e) => setEditing({ ...editing, prompt_override: e.target.value })} rows={5} placeholder={t("translation_languages.promptOverridePlaceholder")} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]" /><p className="mt-1 text-[11px] text-[var(--text-3)]">{t("translation_languages.promptOverrideHint")}</p></div>}
          </div>
          <div className={`mt-6 flex gap-3 ${isMobile ? "sticky bottom-0 bg-[var(--surface)] pt-4" : "justify-end"}`}>
            <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-2.5 text-[13px] text-[var(--text-2)] md:flex-none">{t("common.cancel")}</button>
            <button onClick={handleSave} disabled={!canSave} className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-[13px] font-medium text-white disabled:opacity-50 md:flex-none">{isNew ? t("translation_languages.create") : t("common.save")}</button>
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
      <label htmlFor={selectId} className="mb-1.5 block text-[12px] font-medium text-[var(--text-2)]">
        {label} {required && <span className="text-[var(--red)]">*</span>}
      </label>
      <select
        id={selectId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={help ? helpId : undefined}
        required={required}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] leading-6 text-[var(--text)] outline-none focus:border-[var(--accent)]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {help && <p id={helpId} className="mt-1 text-[11.5px] leading-6 text-[var(--text-3)]">{help}</p>}
    </div>
  );
}
