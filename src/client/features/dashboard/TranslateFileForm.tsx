import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type { TranslateFileRequest } from "../../api";
import type { Task, TaskStatus } from "../../types";
import { useMutationWithInvalidation, useTasksQuery } from "../../hooks";
import { useToast } from "../../ui/Toast";
import { getErrorMessage } from "../../lib";
import { TargetLanguageField } from "../convert/TargetLanguageField";
import { resolveTargetLanguage, type LanguageResolution } from "../convert/resolve-language";

/** What the person picked: one of their tasks, or a language typed into the field. */
export type TranslateChoice =
  | { kind: "task"; task: Task }
  | { kind: "language"; resolution: LanguageResolution };

/** The chosen language, or null while a typed language is ambiguous or unknown. */
function chosenLanguage(choice: TranslateChoice): { langCode: string; targetLang: string } | null {
  if (choice.kind === "task") return { langCode: choice.task.lang_code, targetLang: choice.task.target_lang };
  if (choice.resolution.status !== "resolved") return null;
  const { code, promptName } = choice.resolution.language;
  return { langCode: code, targetLang: promptName };
}

/** The request for a choice, or null while a typed language is ambiguous or unknown. */
export function translateFileRequest(srtPath: string, choice: TranslateChoice): TranslateFileRequest | null {
  if (choice.kind === "task") return { srtPath, taskId: choice.task.id };
  const language = chosenLanguage(choice);
  return language && { srtPath, ...language };
}

interface TranslateFileFormProps {
  srtPath: string;
  /** Tasks already shown on this subtitle; they are not offered again. */
  existingTasks: TaskStatus[];
  onQueued: (task: TaskStatus) => void;
  onCancel: () => void;
}

const buttonBase =
  "inline-flex min-h-touch items-center justify-center rounded-sm px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";

export function TranslateFileForm({ srtPath, existingTasks, onQueued, onCancel }: TranslateFileFormProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { data: tasks = [] } = useTasksQuery();
  const [pickedTask, setPickedTask] = useState<Task | null>(null);
  const [languageInput, setLanguageInput] = useState("");
  const resolution = useMemo(() => resolveTargetLanguage(languageInput), [languageInput]);
  const mutation = useMutationWithInvalidation(api.translateFile);

  const shownTaskIds = new Set(existingTasks.map((task) => task.taskId));
  const quickPicks = tasks.filter((task) => !shownTaskIds.has(task.id));
  const choice: TranslateChoice = pickedTask
    ? { kind: "task", task: pickedTask }
    : { kind: "language", resolution };
  const request = translateFileRequest(srtPath, choice);
  const language = chosenLanguage(choice);

  const typeLanguage = (value: string) => {
    setPickedTask(null);
    setLanguageInput(value);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || !language) return;
    try {
      const result = await mutation.mutateAsync(request);
      onQueued({
        taskId: result.taskId,
        ...language,
        outputName: "",
        outputPath: "",
        status: "pending",
        jobId: result.jobId,
        translatedTitle: null,
        outputExists: false,
      });
      addToast(
        t(result.created ? "scan.translateFile.queued" : "scan.translateFile.alreadyQueued", { lang: language.targetLang }),
        result.created ? "success" : "info",
      );
    } catch {
      // The mutation keeps the error; it renders below the form.
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-3">
      {quickPicks.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">{t("scan.translateFile.yourTasks")}</span>
          <div className="flex flex-wrap gap-2">
            {quickPicks.map((task) => {
              const active = pickedTask?.id === task.id;
              return (
                <button
                  key={task.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setPickedTask(active ? null : task);
                    setLanguageInput("");
                  }}
                  className={`rounded-full border px-3 py-1 text-xs ${active ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-text hover:border-accent-line"}`}
                >
                  {task.target_lang} · {task.lang_code}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <TargetLanguageField
        value={languageInput}
        onChange={typeLanguage}
        resolution={resolution}
        recents={[]}
        onPick={(entry) => typeLanguage(entry.code)}
      />
      {mutation.error && (
        <p role="alert" className="text-xs text-danger">
          {getErrorMessage(mutation.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={`${buttonBase} text-muted hover:text-text`}
        >
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          disabled={!request || mutation.isPending}
          className={`${buttonBase} bg-accent text-accent-text hover:brightness-110`}
        >
          {mutation.isPending ? t("scan.translateFile.submitting") : t("scan.translateFile.submit")}
        </button>
      </div>
    </form>
  );
}
