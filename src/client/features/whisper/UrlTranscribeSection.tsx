import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useToast } from "../../components/Toast";
import { ActionButton, SettingsSection } from "../../ui/primitives";
import { FORMATS, selectCls, type OutputFormat } from "./whisper-shared";

export interface UrlTranscribeSectionProps {
  isMobile: boolean;
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
 * backend has yt-dlp installed. Downloads the rendered subtitle straight to
 * the browser since there's no local media file for a URL.
 */
export function UrlTranscribeSection({
  isMobile, effFormat, effModel, effLang, effDevice, effCompute, canDiarize, effDiarize,
}: UrlTranscribeSectionProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [urlValue, setUrlValue] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);

  const transcribeFromUrl = async () => {
    const url = urlValue.trim();
    if (!url) return;
    setUrlBusy(true);
    try {
      const res = await api.transcribeUrl({
        url, outputFormat: effFormat, model: effModel, language: effLang,
        device: effDevice, computeType: effCompute, speakerDiarization: canDiarize && effDiarize,
      });
      // No local media file for a URL — hand the rendered subtitle to the browser.
      const blob = new Blob([res.content], { type: "text/plain;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      const safeExt = (FORMATS as string[]).includes(res.outputFormat) ? res.outputFormat : effFormat;
      a.download = `transcript.${safeExt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      addToast(t("whisper.urlDone", { segments: res.segments ?? 0 }), "success");
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
          onClick={() => { void transcribeFromUrl(); }}
          disabled={!urlValue.trim()}
          busy={urlBusy}
          className={isMobile ? "w-full" : ""}
        >
          {urlBusy ? t("whisper.urlBusy") : t("whisper.urlButton")}
        </ActionButton>
      </div>
    </SettingsSection>
  );
}
