import { useState } from "react";
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

export function TranslationLanguagesPage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const tasksQuery = useTasksQuery();
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [showPromptOverride, setShowPromptOverride] = useState(false);
  const createMutation = useMutationWithInvalidation<Task, Partial<Task>>((payload) => api.createTask(payload));
  const updateMutation = useMutationWithInvalidation<Task, UpdateTaskVars>(({ id, payload }) => api.updateTask(id, payload));
  const deleteMutation = useMutationWithInvalidation<unknown, number>((id) => api.deleteTask(id));

  const tasks = tasksQuery.data || [];

  const handleSave = async () => {
    if (!editing || !editing.target_lang || !editing.lang_code) return;
    if (isNew) {
      await createMutation.mutateAsync({ source_lang: editing.source_lang || "English", target_lang: editing.target_lang, output_pattern: editing.output_pattern || "{{name}}.{{lang_code}}.srt", lang_code: editing.lang_code });
      if (editing.prompt_override) {
        const allTasks = await api.getTasks();
        const newest = allTasks[allTasks.length - 1];
        if (newest) await api.updateTask(newest.id, { prompt_override: editing.prompt_override });
      }
      addToast(t("translation_languages.toast.created", { lang: editing.target_lang }), "success");
    } else if (editing.id) {
      await updateMutation.mutateAsync({ id: editing.id, payload: editing });
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
    }
  };

  const openNew = (preset?: typeof PRESETS[number]) => {
    setEditing({ source_lang: "English", target_lang: preset?.target_lang || "", output_pattern: preset?.output_pattern || "{{name}}.{{lang_code}}.srt", lang_code: preset?.lang_code || "", prompt_override: "" });
    setIsNew(true);
    setShowPromptOverride(false);
  };

  const langCodeError = editing?.lang_code && /[^a-zA-Z0-9\-_]/.test(editing.lang_code) ? t("translation_languages.langCodeError") : "";
  const patternError = editing?.output_pattern && !editing.output_pattern.includes("{{name}}") ? t("translation_languages.patternError") : "";
  const canSave = editing?.target_lang && editing?.lang_code && !langCodeError && !patternError;
  const previewExample = editing?.output_pattern ? editing.output_pattern.replace("{{name}}", "The.Matrix.1999").replace("{{lang_code}}", editing.lang_code || "xx").replace("{{ext}}", "srt") : "";

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
      </section>

      <section className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
        {tasks.map((task) => (
          <div key={task.id} className={`rounded-3xl border p-5 ${task.enabled ? "border-gray-800 bg-gray-900/80" : "border-gray-800/50 bg-gray-900/40 opacity-60"}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-200"><span>{task.source_lang}</span><span className="text-gray-600">→</span><span>{task.target_lang}</span></div>
                <div className="mt-2 space-y-2 text-xs text-gray-500">
                  <div className="font-mono rounded-xl bg-gray-800 px-2 py-1 inline-block">{task.output_pattern}</div>
                  <div>{t("translation_languages.langCodeLabel", { code: task.lang_code })}</div>
                  {task.prompt_override && <div className="text-blue-400">{t("translation_languages.customPrompt")}</div>}
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <button onClick={() => updateMutation.mutate({ id: task.id, payload: { enabled: task.enabled ? 0 : 1 } })} className={`rounded-full px-3 py-1.5 text-xs font-medium ${task.enabled ? "bg-green-900/30 text-green-400" : "bg-gray-800 text-gray-500"}`}>{task.enabled ? t("translation_languages.enabled") : t("translation_languages.disabled")}</button>
                <button onClick={() => { setEditing({ ...task }); setIsNew(false); setShowPromptOverride(!!task.prompt_override); }} className="text-xs text-gray-400 hover:text-gray-200">{t("translation_languages.edit")}</button>
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
                <Field label={t("translation_languages.outputPattern")} value={editing.output_pattern || ""} onChange={(v) => setEditing({ ...editing, output_pattern: v })} placeholder="{{name}}.{{lang_code}}.srt" error={patternError} help={t("translation_languages.patternHelp")} />
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
