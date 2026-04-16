import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useTasksQuery, useMutationWithInvalidation } from "../../hooks";
import type { Task } from "../../types";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmModal";
import { PRESETS } from "../../app/constants";
import { ActionButton, EmptyHint, Field } from "../../ui/primitives";

interface UpdateTaskVars {
  id: number;
  payload: Partial<Task>;
}

const OUTPUT_FORMATS = ["srt", "vtt", "ass", "ssa"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

function inferOutputFormat(pattern?: string): OutputFormat {
  const normalized = (pattern || "").toLowerCase().trim();
  const extMatch = normalized.match(/\.(srt|vtt|ass|ssa)$/);
  if (extMatch) return extMatch[1] as OutputFormat;
  return "srt";
}

function applyOutputFormat(pattern: string | undefined, format: OutputFormat): string {
  const base = (pattern || "{{name}}.{{lang_code}}.srt").trim();
  if (!base) return `{{name}}.{{lang_code}}.${format}`;
  if (base.includes("{{ext}}")) return base.replaceAll("{{ext}}", format);
  if (/\.(srt|vtt|ass|ssa)$/i.test(base)) return base.replace(/\.(srt|vtt|ass|ssa)$/i, `.${format}`);
  return `${base}.${format}`;
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
    if (isNew) {
      await createMutation.mutateAsync({ source_lang: editing.source_lang || "English", target_lang: editing.target_lang, output_pattern: normalizedOutputPattern, lang_code: editing.lang_code });
      if (editing.prompt_override) {
        const allTasks = await api.getTasks();
        const newest = allTasks[allTasks.length - 1];
        if (newest) await api.updateTask(newest.id, { prompt_override: editing.prompt_override });
      }
      addToast(t("translation_languages.toast.created", { lang: editing.target_lang }), "success");
    } else if (editing.id) {
      await updateMutation.mutateAsync({ id: editing.id, payload: { ...editing, output_pattern: normalizedOutputPattern } });
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
    const output_pattern = preset?.output_pattern || "{{name}}.{{lang_code}}.srt";
    setEditing({ source_lang: "English", target_lang: preset?.target_lang || "", output_pattern, lang_code: preset?.lang_code || "", prompt_override: "" });
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

  const bulkCounts = useMemo(() => ({
    enabled: selectedTasks.filter((x) => x.enabled === 1).length,
    disabled: selectedTasks.filter((x) => x.enabled !== 1).length,
  }), [selectedTasks]);

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-4 md:p-6">
      <section className="rounded-3xl border border-gray-800 bg-gray-900/80 p-5 md:p-6">
        <div className={`flex ${isMobile ? "flex-col gap-4" : "items-center justify-between gap-4"}`}>
          <div>
            <h1 className="text-2xl font-semibold">{t("translation_languages.title")}</h1>
          </div>
          <ActionButton onClick={() => openNew()}>{t("translation_languages.addLanguage")}</ActionButton>
        </div>
        <div className="mt-5 rounded-2xl border border-gray-800 bg-gray-950/50 p-4">
          <p className="mb-3 text-xs text-gray-500">{t("translation_languages.presets")}</p>
          <div className="flex flex-wrap gap-2">{PRESETS.map((p) => { const exists = tasks.some((task) => task.lang_code === p.lang_code); return <button key={p.lang_code} onClick={() => !exists && openNew(p)} disabled={exists} className={`rounded-full px-3 py-2 text-xs font-medium ${exists ? "bg-gray-800 text-gray-600" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}>{p.label} {exists && "✓"}</button>; })}</div>
        </div>

        {selectedTasks.length > 0 && (
          <div className="mt-4 rounded-2xl border border-blue-800/40 bg-blue-900/10 p-4">
            <div className="mb-2 text-sm font-semibold text-blue-100">{t("translation_languages.bulk.title", { count: selectedTasks.length })}</div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => applyBulk({ enabled: 1 })} disabled={bulkCounts.disabled === 0} className="rounded-lg bg-green-700 px-3 py-2 text-xs text-white disabled:opacity-40">{t("translation_languages.bulk.enable")}</button>
              <button onClick={() => applyBulk({ enabled: 0 })} disabled={bulkCounts.enabled === 0} className="rounded-lg bg-gray-700 px-3 py-2 text-xs text-white disabled:opacity-40">{t("translation_languages.bulk.disable")}</button>
              {OUTPUT_FORMATS.map((format) => (
                <button key={format} onClick={() => applyBulkFormat(format)} className="rounded-lg bg-gray-800 px-3 py-2 text-xs text-gray-200 uppercase">{t("translation_languages.bulk.setFormat", { format })}</button>
              ))}
              <button onClick={clearSelection} className="ml-auto rounded-lg bg-gray-800 px-3 py-2 text-xs text-gray-300">{t("translation_languages.bulk.clearSelection")}</button>
            </div>
          </div>
        )}
      </section>

      <section className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
        {tasks.map((task) => (
          <div key={task.id} className={`rounded-3xl border p-5 ${task.enabled ? "border-gray-800 bg-gray-900/80" : "border-gray-800/50 bg-gray-900/40 opacity-60"}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <input type="checkbox" checked={selectedTaskIds.has(task.id)} onChange={() => toggleTaskSelected(task.id)} className="mt-1 h-4 w-4 accent-blue-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-200"><span>{task.source_lang}</span><span className="text-gray-600">→</span><span>{task.target_lang}</span></div>
                  <div className="mt-2 space-y-2 text-xs text-gray-500">
                    <div className="font-mono rounded-xl bg-gray-800 px-2 py-1 inline-block">{task.output_pattern}</div>
                    <div>{t("translation_languages.langCodeLabel", { code: task.lang_code })}</div>
                    {task.prompt_override && <div className="text-blue-400">{t("translation_languages.customPrompt")}</div>}
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <button onClick={() => updateMutation.mutate({ id: task.id, payload: { enabled: task.enabled ? 0 : 1 } })} className={`rounded-full px-3 py-1.5 text-xs font-medium ${task.enabled ? "bg-green-900/30 text-green-400" : "bg-gray-800 text-gray-500"}`}>{task.enabled ? t("translation_languages.enabled") : t("translation_languages.disabled")}</button>
                <button onClick={() => openEdit(task)} className="text-xs text-gray-400 hover:text-gray-200">{t("translation_languages.edit")}</button>
                <button onClick={() => handleDelete(task)} className="text-xs text-gray-600 hover:text-red-400">{t("translation_languages.delete")}</button>
              </div>
            </div>
          </div>
        ))}
        {tasks.length === 0 && <div className="col-span-full"><EmptyHint text={t("translation_languages.noTasks")} subtext={t("translation_languages.noTasksHint")} /></div>}
      </section>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/70 p-0 md:p-4" onClick={() => { setEditing(null); setIsNew(false); }}>
          <div className="mx-auto flex h-full items-center justify-center">
            <div className={`w-full border border-gray-700 bg-gray-900 ${isMobile ? "h-full rounded-none overflow-y-auto p-4" : "max-w-xl rounded-3xl p-6"}`} onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold">{isNew ? t("translation_languages.addModal") : t("translation_languages.editModal")}</h3>
              <div className="mt-4 space-y-4">
                <Field label={t("translation_languages.sourceLang")} value={editing.source_lang || ""} onChange={(v) => setEditing({ ...editing, source_lang: v })} placeholder="English" />
                <Field label={t("translation_languages.targetLang")} value={editing.target_lang || ""} onChange={(v) => setEditing({ ...editing, target_lang: v })} placeholder="Traditional Chinese (Taiwan)" required />
                <Field label={t("translation_languages.langCode")} value={editing.lang_code || ""} onChange={(v) => setEditing({ ...editing, lang_code: v })} placeholder="chi" error={langCodeError} help={t("translation_languages.langCodeHelp")} required />
                <div>
                  <div className="mb-2 text-sm font-medium text-gray-300">{t("translation_languages.outputFormat")}</div>
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
                          className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wide ${active ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}
                        >
                          {format}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[10px] text-gray-600">{t("translation_languages.outputFormatHelp")}</p>
                </div>
                {hasMismatch && (
                  <div className="rounded-2xl border border-yellow-700/40 bg-yellow-900/20 p-3 text-xs text-yellow-100">
                    {t("translation_languages.formatMismatch", { selected: selectedOutputFormat, detected: patternFormat })}
                    <div>
                      <button onClick={() => setEditing({ ...editing, output_pattern: applyOutputFormat(editing.output_pattern, selectedOutputFormat) })} className="mt-2 rounded-lg bg-yellow-700 px-2 py-1 font-medium text-white">
                        {t("translation_languages.fixPattern")}
                      </button>
                    </div>
                  </div>
                )}
                <Field label={t("translation_languages.outputPattern")} value={editing.output_pattern || ""} onChange={(v) => setEditing({ ...editing, output_pattern: v })} placeholder="{{name}}.{{lang_code}}.srt" error={patternError} help={t("translation_languages.patternHelp")} />
                <div>
                  <button onClick={() => setEditing({ ...editing, output_pattern: `{{name}}.{{lang_code}}.${selectedOutputFormat}` })} className="rounded-lg bg-gray-800 px-2 py-1 text-[11px] text-gray-200">
                    {t("translation_languages.resetRecommended")}
                  </button>
                </div>
                {previewExample && <div className="rounded-2xl bg-gray-800 p-3 text-xs font-mono"><div className="text-gray-500">{t("translation_languages.previewSource")} <span className="text-gray-400">The.Matrix.1999.en.srt</span></div><div className="mt-1 text-gray-500">{t("translation_languages.previewOutput")} <span className="text-green-400">{previewExample}</span></div></div>}
                {!showPromptOverride ? <button onClick={() => setShowPromptOverride(true)} className="text-xs text-blue-400">{t("translation_languages.addPromptOverride")}</button> : <div><div className="mb-1 flex items-center justify-between"><label className="text-sm font-medium text-gray-300">{t("translation_languages.promptOverride")}</label><button onClick={() => { setShowPromptOverride(false); setEditing({ ...editing, prompt_override: "" }); }} className="text-[10px] text-gray-600">{t("translation_languages.removePromptOverride")}</button></div><textarea value={editing.prompt_override || ""} onChange={(e) => setEditing({ ...editing, prompt_override: e.target.value })} rows={5} placeholder={t("translation_languages.promptOverridePlaceholder")} className="w-full rounded-2xl border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 font-mono" /><p className="mt-1 text-[10px] text-gray-600">{t("translation_languages.promptOverrideHint")}</p></div>}
              </div>
              <div className={`mt-6 flex gap-3 ${isMobile ? "sticky bottom-0 bg-gray-900 pt-4" : "justify-end"}`}>
                <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 md:flex-none px-4 py-3 text-sm text-gray-400">{t("common.cancel")}</button>
                <button onClick={handleSave} disabled={!canSave} className="flex-1 md:flex-none rounded-2xl bg-blue-600 px-4 py-3 text-sm font-medium disabled:opacity-50">{isNew ? t("translation_languages.create") : t("common.save")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
