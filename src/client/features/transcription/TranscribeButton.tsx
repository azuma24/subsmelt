import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useToast } from "../../components/Toast";
import { getErrorMessage } from "../../lib";
import { ProgressSmall } from "../../ui/primitives";
import type { TranscriptionJob } from "../../types";

interface Props {
  videoPath: string;
  /** Optional: the live transcription job for this video (if any). */
  activeJob?: TranscriptionJob;
  disabled?: boolean;
  compact?: boolean;
}

function stageLabel(stage: string | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch ((stage || "").toLowerCase()) {
    case "extracting":
      return t("transcription.stage.extracting");
    case "uvr":
      return t("transcription.stage.uvr");
    case "vad":
      return t("transcription.stage.vad");
    case "transcribing":
      return t("transcription.stage.transcribing");
    case "writing":
      return t("transcription.stage.writing");
    case "downloading":
      return t("transcription.stage.downloading");
    case "submitting":
      return t("transcription.stage.submitting");
    case "queued":
      return t("transcription.stage.queued");
    default:
      return stage || t("transcription.stage.working");
  }
}

export function TranscribeButton({ videoPath, activeJob, disabled, compact }: Props) {
  const { t } = useTranslation();
  const { addToast } = useToast();

  const run = async () => {
    try {
      await api.transcribeVideo(videoPath);
      addToast(t("transcription.toast.started", { name: videoPath.split("/").pop() || videoPath }), "info");
    } catch (e: unknown) {
      addToast(t("transcription.toast.failed", { message: getErrorMessage(e) }), "error");
    }
  };

  const cancel = async () => {
    if (!activeJob) return;
    try {
      await api.cancelTranscription(activeJob.id);
      addToast(t("transcription.toast.cancelled"), "info");
    } catch (e: unknown) {
      addToast(t("transcription.toast.cancelFailed", { message: getErrorMessage(e) }), "error");
    }
  };

  if (activeJob && (activeJob.status === "pending" || activeJob.status === "running")) {
    const pct = Math.max(0, Math.min(100, Math.round(activeJob.progress * 100)));
    return (
      <div className={`flex items-center gap-2 ${compact ? "min-w-[160px]" : "min-w-[220px]"}`}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-wide text-blue-300">
            {stageLabel(activeJob.stage, t)}
          </div>
          <ProgressSmall pct={pct} />
        </div>
        <button
          type="button"
          onClick={cancel}
          className="rounded-lg bg-red-900/40 px-2 py-1 text-[11px] text-red-200 hover:bg-red-800/50"
        >
          {t("transcription.cancel")}
        </button>
      </div>
    );
  }

  if (activeJob && activeJob.status === "error") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-red-400" title={activeJob.error || ""}>
          ⚠ {t("transcription.errorShort")}
        </span>
        <button
          type="button"
          onClick={run}
          disabled={disabled}
          className="rounded-lg bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {t("transcription.retry")}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={disabled}
      className={`rounded-lg bg-blue-600 ${compact ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs"} font-medium text-white hover:bg-blue-700 disabled:opacity-50`}
      title={t("transcription.buttonHint")}
    >
      🎙 {t("transcription.runButton")}
    </button>
  );
}
