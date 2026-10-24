import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { useToast } from "../../ui/Toast";
import { ActionButton, SettingsSection } from "../../ui/primitives";
import { FORMATS, selectCls, type OutputFormat } from "./whisper-shared";
import { useIsMobile } from "../../hooks";

export interface UrlTranscribeSectionProps {
  effFormat: OutputFormat;
  effModel: string;
  effLang: string;
  effDevice: string;
  effCompute: string;
  canDiarize: boolean;
  effDiarize: boolean;
}

/**
 * "Transcribe from URL" settings section. Rendered by the caller only when the
 * backend has yt-dlp installed. Outputs are persisted server-side until fetched.
 */
export function UrlTranscribeSection({
  effFormat,
  effModel,
  effLang,
  effDevice,
  effCompute,
  canDiarize,
  effDiarize,
}: UrlTranscribeSectionProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [urlValue, setUrlValue] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const workQuery = useQuery({
    queryKey: ["transcription-work"],
    queryFn: api.listTranscriptionWork,
    refetchInterval: 1500,
  });
  const urlWork = (workQuery.data?.items ?? []).filter((item) => item.kind === "url").reverse();
  const download = async (id: string) => {
    const res = await api.getTranscriptionWork(id);
    if (res.status !== "succeeded" || !res.content) return;
    const href = URL.createObjectURL(new Blob([res.content], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = href;
    a.download = `transcript.${(FORMATS as string[]).includes(res.outputFormat ?? "") ? res.outputFormat : effFormat}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  };

  const transcribeFromUrl = async () => {
    const url = urlValue.trim();
    if (!url) return;
    setUrlBusy(true);
    try {
      await api.queueTranscriptionWork([
        {
          kind: "url",
          input: url,
          request: {
            outputFormat: effFormat,
            model: effModel,
            language: effLang,
            device: effDevice,
            computeType: effCompute,
            speakerDiarization: canDiarize && effDiarize,
          },
        },
      ]);
      void workQuery.refetch();
      setUrlValue("");
    } catch (e: unknown) {
      addToast(`${t("whisper.urlFailed")}: ${e instanceof Error ? e.message : t("whisper.failedFallback")}`, "error");
    } finally {
      setUrlBusy(false);
    }
  };

  return (
    <SettingsSection title={t("whisper.urlTitle")} description={t("whisper.urlHint")}>
      <div className={`flex gap-2 ${isMobile ? "flex-col items-stretch" : "items-center"}`}>
        <input
          type="url"
          aria-label={t("whisper.urlPlaceholder")}
          value={urlValue}
          onChange={(e) => setUrlValue(e.target.value)}
          placeholder={t("whisper.urlPlaceholder")}
          className={`${selectCls} min-w-0 flex-1`}
        />
        <ActionButton
          variant="primary"
          size="sm"
          onClick={() => {
            void transcribeFromUrl();
          }}
          disabled={!urlValue.trim()}
          busy={urlBusy}
          className={isMobile ? "w-full" : ""}
        >
          {urlBusy ? t("whisper.urlBusy") : t("whisper.urlButton")}
        </ActionButton>
      </div>
      <div className="space-y-2">
        {urlWork.map((item) => (
          <div key={item.id} className="flex items-center gap-2 text-sm text-muted">
            <span className="min-w-0 flex-1 truncate" title={item.input}>
              {item.input}
            </span>
            <span>
              {item.status === "running"
                ? `${t("transcriptionHistory.status.running")} ${item.progress}%`
                : item.status === "queued"
                  ? t("dashboard.status.pending")
                  : t(`transcriptionHistory.status.${item.status}`)}
            </span>
            {item.status === "succeeded" && (
              <button type="button" className="underline" onClick={() => void download(item.id)}>
                {t("settings.models.download")}
              </button>
            )}
            {(item.status === "running" || item.status === "queued") && (
              <button
                type="button"
                className="underline"
                onClick={() => void api.cancelTranscriptionWork(item.id).then(() => workQuery.refetch())}
              >
                {t("whisper.cancel")}
              </button>
            )}
            {item.error && <span title={item.error}>{item.error}</span>}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
