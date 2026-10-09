import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { useMutationWithInvalidation } from "../../hooks";
import { useToast } from "../../ui/Toast";
import type { Job, TaskStatus } from "../../types";
import { Icon } from "../../ui/Icon";
import type { UseManualTranscriptionResult } from "../dashboard/useManualTranscription";
import { itemTasks, relevantJobId, type LibraryItem } from "./library-model";
import { ErrorBlock, SubtitleLanguages, TranscribeBlock, type FailedTask } from "./PanelSections";

/** At this width the panel sits beside the list; below it, it overlays as a drawer or sheet. */
const INLINE_PANEL_QUERY = "(min-width: 1024px)";
const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])";
const TEXT_ENTRY = "input, textarea, select, [contenteditable]";

function useInlinePanel(): boolean {
  const [inline, setInline] = useState(() => window.matchMedia(INLINE_PANEL_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(INLINE_PANEL_QUERY);
    const onChange = () => setInline(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return inline;
}

interface LibraryPanelProps {
  item: LibraryItem;
  jobsById: Map<number, Job>;
  transcriptionEnabled: boolean;
  transcription: UseManualTranscriptionResult;
  onClose: () => void;
  onPreview: (jobId: number) => void;
  onQueued: (srtPath: string, task: TaskStatus) => void;
  onOpenJob: (jobId: number) => void;
}

export function LibraryPanel({
  item,
  jobsById,
  transcriptionEnabled,
  transcription,
  onClose,
  onPreview,
  onQueued,
  onOpenJob,
}: LibraryPanelProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const closeRef = useRef<HTMLButtonElement>(null);
  const inline = useInlinePanel();
  const retryMutation = useMutationWithInvalidation((ids: number[]) => api.retryJobsApi(ids));

  // Overlaying (drawer or sheet), the panel is modal, so focus moves into it.
  // Beside the list it is not, and focus stays on the row so j/k keep working.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves into the panel for each new item
  useEffect(() => {
    if (!inline) closeRef.current?.focus();
  }, [item.key, inline]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A modal above handles its own Escape; in a text field Escape belongs to the field.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest(TEXT_ENTRY)) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const failed: FailedTask[] = itemTasks(item).flatMap((task) => {
    const job = task.jobId === null ? undefined : jobsById.get(task.jobId);
    return job?.status === "error" ? [{ task, job }] : [];
  });
  const retry = () => {
    retryMutation.mutate(
      failed.map(({ job }) => job.id),
      {
        onSuccess: (result) => addToast(t("dashboard.toast.retrySelectedStarted", { count: result.updated }), "info"),
        onError: () => addToast(t("dashboard.toast.actionFailed"), "error"),
      },
    );
  };
  const trapTab = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (inline || event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  const videoPath = item.file.videoPath;
  const needsTranscription = item.kind === "video" && item.file.subtitles.length === 0;
  const jobId = relevantJobId(item, jobsById);

  return (
    <>
      <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-40 bg-scrim lg:hidden" />
      <aside
        {...(inline ? { role: "complementary" } : { role: "dialog", "aria-modal": true })}
        aria-labelledby="library-panel-title"
        onKeyDown={trapTab}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-md border-t border-border bg-surface shadow-2 animate-slide-up md:animate-slide-in md:inset-y-0 md:left-auto md:w-[400px] md:max-h-none md:rounded-none md:border-l md:border-t-0 lg:static lg:z-auto lg:shrink-0 lg:shadow-none lg:animate-none"
      >
        <header className="flex items-start gap-3 border-b border-border p-4">
          <Icon name={item.kind === "video" ? "video" : "subtitle"} size={20} className="text-muted" />
          <h2
            id="library-panel-title"
            className="min-w-0 flex-1 break-words text-base font-semibold text-text [overflow-wrap:anywhere]"
          >
            {item.name}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("library.panel.close")}
            className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-raised hover:text-text"
          >
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">{t("library.panel.folder")}</dt>
            <dd className="font-mono text-xs leading-5 text-text [overflow-wrap:anywhere]">
              {item.folder || t("library.folder.root")}
            </dd>
            <dt className="text-muted">{t("library.panel.kind")}</dt>
            <dd className="text-text">
              {item.kind === "video" ? t("library.panel.kindVideo") : t("library.panel.kindSubtitle")}
            </dd>
          </dl>
          {failed.length > 0 && <ErrorBlock failed={failed} busy={retryMutation.isPending} onRetry={retry} />}
          {needsTranscription && videoPath && (
            <TranscribeBlock
              enabled={transcriptionEnabled}
              progress={transcription.transcriptionProgressByPath[videoPath]}
              onTranscribe={(postAction) => void transcription.handleTranscribe(videoPath, postAction)}
              onCancel={() => void transcription.handleCancelTranscription(videoPath)}
            />
          )}
          {item.file.subtitles.map((subtitle) => (
            <SubtitleLanguages
              key={subtitle.srtPath}
              subtitle={subtitle}
              jobsById={jobsById}
              showName={item.kind === "video"}
              onPreview={onPreview}
              onQueued={onQueued}
            />
          ))}
        </div>
        {jobId !== null && (
          <footer className="border-t border-border px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={() => onOpenJob(jobId)}
              className="inline-flex min-h-touch items-center text-sm font-medium text-accent underline"
            >
              {t("library.panel.openJob")}
            </button>
          </footer>
        )}
      </aside>
    </>
  );
}
