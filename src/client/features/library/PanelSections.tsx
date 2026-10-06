import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import type { Job, SubtitleEntry, TaskStatus } from "../../types";
import { useJobActions } from "../../hooks/useJobActions";
import { Icon } from "../../ui/Icon";
import { TranslateFileForm } from "../dashboard/TranslateFileForm";
import {
  isManualTranscriptionBusy,
  type ManualTranscriptionProgress,
  type TranscribePostAction,
} from "../dashboard/transcription-progress";
import { languageState } from "./library-model";
import { getTaskStatus, languageStatusDisplay, stageText, stageTone } from "./task-status";
import { LanguageChip } from "./LanguageChip";

const SECONDARY =
  "inline-flex min-h-touch items-center justify-center gap-2 rounded-sm border border-border bg-surface px-3 text-sm font-medium text-text transition-colors duration-fast hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-45";
// Scan in the page header is the screen's one filled button; panel actions stay outlined.
const EMPHASIS =
  "inline-flex min-h-touch items-center justify-center gap-2 rounded-sm border border-accent-line bg-accent-soft px-3 text-sm font-medium text-accent transition-colors duration-fast hover:border-accent disabled:cursor-not-allowed disabled:opacity-45";
const DANGER =
  "inline-flex min-h-touch items-center justify-center gap-2 rounded-sm border border-danger-line bg-surface px-3 text-sm font-medium text-danger transition-colors duration-fast hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-45";
const HEADING = "text-xs font-semibold uppercase tracking-wide text-muted";

export interface FailedTask {
  task: TaskStatus;
  job: Job;
}

/** The one place a failure is retried; language rows only point here. */
export function ErrorBlock({ failed, busy, onRetry }: { failed: FailedTask[]; busy: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <section role="alert" className="space-y-3 rounded-md border border-danger-line bg-danger-soft p-4">
      <h3 className="text-sm font-semibold text-danger">{t("library.panel.failed", { count: failed.length })}</h3>
      <ul className="space-y-1">
        {failed.map(({ task, job }) => (
          <li key={job.id} className="text-sm text-text">
            <span className="font-mono text-xs text-danger">{task.langCode}</span>{" "}
            <span className="[overflow-wrap:anywhere]">{job.error || t("dashboard.status.error")}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onRetry} disabled={busy} className={DANGER}>
        <Icon name="retry" />
        {failed.length === 1 ? t("library.panel.retry") : t("library.panel.retryAll", { count: failed.length })}
      </button>
    </section>
  );
}

interface TranscribeBlockProps {
  enabled: boolean;
  progress: ManualTranscriptionProgress | undefined;
  onTranscribe: (postAction: TranscribePostAction) => void;
  onCancel: () => void;
}

export function TranscribeBlock({ enabled, progress, onTranscribe, onCancel }: TranscribeBlockProps) {
  const { t } = useTranslation();
  const busy = isManualTranscriptionBusy(progress);
  if (!enabled) {
    return (
      <section className="space-y-2 rounded-md border border-border bg-surface-raised p-4">
        <h3 className="text-sm font-semibold text-text">{t("library.panel.noSubtitlesTitle")}</h3>
        <p className="text-sm text-muted">{t("library.panel.sttOff")}</p>
        <Link
          to="/settings?section=stt"
          className="inline-flex min-h-touch items-center text-sm font-medium text-accent underline"
        >
          {t("library.panel.openSttSettings")}
        </Link>
      </section>
    );
  }
  return (
    <section className="space-y-3 rounded-md border border-border bg-surface-raised p-4">
      <h3 className="text-sm font-semibold text-text">{t("library.panel.noSubtitlesTitle")}</h3>
      <p className="text-sm text-muted">{t("library.panel.noSubtitlesBody")}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onTranscribe("transcribe_and_translate")}
          className={EMPHASIS}
        >
          {busy && progress?.postAction === "transcribe_and_translate"
            ? t("scan.transcription.working")
            : t("scan.transcription.transcribeTranslate")}
        </button>
        <button type="button" disabled={busy} onClick={() => onTranscribe("transcribe_only")} className={SECONDARY}>
          {busy && progress?.postAction === "transcribe_only"
            ? t("scan.transcription.working")
            : t("scan.transcription.transcribe")}
        </button>
        {progress?.stage === "transcribing" && (
          <button type="button" onClick={onCancel} className={DANGER}>
            {t("scan.transcription.cancel")}
          </button>
        )}
      </div>
      {progress && (
        <p role="status" className={`text-sm ${stageTone(progress.stage)}`}>
          {stageText(progress, t)}
        </p>
      )}
      {progress?.stage === "transcribing" && typeof progress.pct === "number" && (
        <div className="h-2 overflow-hidden rounded-full bg-surface" aria-hidden="true">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-base"
            style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }}
          />
        </div>
      )}
    </section>
  );
}

interface SubtitleLanguagesProps {
  subtitle: SubtitleEntry;
  jobsById: Map<number, Job>;
  showName: boolean;
  onPreview: (jobId: number) => void;
  onQueued: (srtPath: string, task: TaskStatus) => void;
}

export function SubtitleLanguages({ subtitle, jobsById, showName, onPreview, onQueued }: SubtitleLanguagesProps) {
  const { t } = useTranslation();
  const actions = useJobActions();
  const [translating, setTranslating] = useState(false);
  return (
    <section className="space-y-2">
      <h3 className={HEADING}>{t("library.panel.languages")}</h3>
      {showName && <p className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{subtitle.srtName}</p>}
      {subtitle.tasks.length === 0 ? (
        <p className="text-sm text-muted">
          {t("library.panel.noLanguages")}{" "}
          <Link to="/settings/languages" className="font-medium text-accent underline">
            {t("library.panel.openLanguageSettings")}
          </Link>
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {subtitle.tasks.map((task) => {
            const status = getTaskStatus(task, jobsById);
            const state = languageState(status);
            const job = task.jobId === null ? undefined : jobsById.get(task.jobId);
            const progress =
              state === "translating" && job && job.total_cues > 0 ? ` ${job.completed_cues}/${job.total_cues}` : "";
            return (
              <li key={task.taskId} className="flex min-h-touch flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <LanguageChip task={task} status={status} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-text">{task.targetLang}</span>
                  <span className={`block text-xs ${state === "error" ? "text-danger" : "text-muted"}`}>
                    {state === "error"
                      ? t("library.panel.seeError")
                      : `${t(languageStatusDisplay(task, status).labelKey ?? status)}${progress}`}
                  </span>
                </span>
                {state === "done" && job && (
                  <>
                    <button type="button" onClick={() => onPreview(job.id)} className={SECONDARY}>
                      {t("library.panel.preview")}
                    </button>
                    <Link
                      to={`/jobs/${job.id}`}
                      className="inline-flex min-h-touch items-center px-1 text-xs text-accent underline"
                    >
                      {t("library.panel.jobDetails")}
                    </Link>
                  </>
                )}
                {state === "translating" && job && (
                  <button
                    type="button"
                    onClick={() => actions.cancel(job.id)}
                    disabled={actions.isCancelling}
                    className={SECONDARY}
                  >
                    {t("library.panel.cancel")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {translating ? (
        <TranslateFileForm
          srtPath={subtitle.srtPath}
          existingTasks={subtitle.tasks}
          onQueued={(task) => {
            setTranslating(false);
            onQueued(subtitle.srtPath, task);
          }}
          onCancel={() => setTranslating(false)}
        />
      ) : (
        <button type="button" onClick={() => setTranslating(true)} className={SECONDARY}>
          {t("library.panel.translateTo")}
        </button>
      )}
    </section>
  );
}
