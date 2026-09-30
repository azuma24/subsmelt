import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../../api";
import { useYoutubeStatusQuery } from "../../../hooks";
import { getErrorMessage } from "../../../lib";
import { str } from "../../../lib/settings-value";
import { FORM_CONTROL_CLS, FORM_LABEL_CLS } from "../../../ui/form-classes";
import { ActionButton } from "../../../ui/primitives";

// GET /api/settings returns this in place of a saved secret (REDACTED_SECRET in src/server/connections.ts).
const REDACTED_SECRET = "__SUBSMELT_SECRET_REDACTED__";

type KeyState = { tone: "off" | "ok" | "warn" | "bad"; text: string };

const TONE_CLS: Record<KeyState["tone"], string> = {
  off: "text-[var(--text-3)]",
  ok: "text-[var(--green)]",
  warn: "text-[var(--yellow)]",
  bad: "text-[var(--red)]",
};
const TONE_GLYPH: Record<KeyState["tone"], string> = { off: "○", ok: "✓", warn: "!", bad: "✕" };

interface YoutubeSectionProps {
  settings: Record<string, unknown>;
  /** Deferred writer, committed by the topbar Save. */
  update: (key: string, value: unknown) => void;
  /** Debounced autosave, used for the API key like the other secrets. */
  updateAndSaveDebounced: (key: string, value: unknown) => void;
}

function StatusLine({ state }: { state: KeyState }) {
  return (
    <p role="status" className={`text-[12px] leading-5 ${TONE_CLS[state.tone]}`}>
      <span aria-hidden="true">{TONE_GLYPH[state.tone]} </span>
      {state.text}
    </p>
  );
}

export function YoutubeSection({ settings, update, updateAndSaveDebounced }: YoutubeSectionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const statusQuery = useYoutubeStatusQuery();
  const ids = { key: useId(), download: useId(), notes: useId() };
  const apiKey = str(settings.youtube_api_key);
  const keySaved = apiKey === REDACTED_SECRET;
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<KeyState | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<KeyState | null>(null);

  const keyState: KeyState = tested
    ?? (apiKey ? { tone: "off", text: t("settings.youtube.keySaved") } : { tone: "off", text: t("settings.youtube.keyNotSet") });

  const testKey = async () => {
    if (!apiKey) {
      setTested({ tone: "warn", text: t("settings.youtube.pasteFirst") });
      return;
    }
    setTesting(true);
    try {
      await api.testYoutubeApiKey(keySaved ? "" : apiKey);
      setTested({ tone: "ok", text: t("settings.youtube.keyWorks") });
    } catch (error) {
      setTested({ tone: "bad", text: t("settings.youtube.keyFailed", { error: getErrorMessage(error) }) });
    }
    setTesting(false);
  };

  const updateDownloader = async () => {
    setUpdating(true);
    try {
      const result = await api.updateYtdlp();
      setUpdateResult({ tone: "ok", text: t("settings.youtube.updated", { version: result.version ?? "?" }) });
      await queryClient.invalidateQueries({ queryKey: ["youtube", "status"] });
    } catch (error) {
      setUpdateResult({ tone: "bad", text: t("settings.youtube.updateFailed", { error: getErrorMessage(error) }) });
    }
    setUpdating(false);
  };

  const notes = statusQuery.data?.notes;
  const ytdlp = statusQuery.data?.ytdlp;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor={ids.key} className={FORM_LABEL_CLS}>
          {t("settings.youtube.apiKey")} <span className="font-normal text-[var(--text-3)]">{t("settings.youtube.optional")}</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={ids.key}
            type={showKey && !keySaved ? "text" : "password"}
            value={apiKey}
            onChange={(e) => {
              setTested(null);
              updateAndSaveDebounced("youtube_api_key", e.target.value.trim());
            }}
            placeholder="AIza…"
            autoComplete="off"
            spellCheck={false}
            className={`${FORM_CONTROL_CLS} min-h-[44px] min-w-0 flex-1 basis-[220px] font-mono`}
          />
          <ActionButton variant="ghost" size="sm" onClick={() => setShowKey((s) => !s)} disabled={keySaved || !apiKey}>
            {showKey ? t("settings.youtube.hide") : t("settings.youtube.show")}
          </ActionButton>
          <ActionButton variant="ghost" size="sm" onClick={() => void testKey()} busy={testing}>
            {testing ? t("common.testing") : t("settings.youtube.testKey")}
          </ActionButton>
        </div>
        <StatusLine state={keyState} />
        <p className="text-[12px] leading-5 text-[var(--text-3)]">{t("settings.youtube.keyHint")}</p>
        <details className="text-[12px] leading-5 text-[var(--text-2)]">
          <summary className="flex min-h-[44px] cursor-pointer items-center font-medium text-[var(--text)]">{t("settings.youtube.howTo")}</summary>
          <ol className="list-decimal space-y-1 pb-1 pl-5">
            {(["step1", "step2", "step3", "step4"] as const).map((step) => <li key={step}>{t(`settings.youtube.${step}`)}</li>)}
          </ol>
        </details>
      </div>

      <div className="space-y-1.5 md:max-w-[420px]">
        <label htmlFor={ids.download} className={FORM_LABEL_CLS}>{t("settings.youtube.downloadFolder")}</label>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 max-w-[45%] shrink truncate font-mono text-[12px] text-[var(--text-3)]" dir="rtl" title={str(settings._media_dir, "/media").replace(/\/+$/, "")}><bdi>{str(settings._media_dir, "/media").replace(/\/+$/, "")}</bdi></span><span className="-ml-1 font-mono text-[12px] text-[var(--text-3)]">/</span>
          <input
            id={ids.download}
            value={str(settings.youtube_download_dir, "YouTube")}
            onChange={(e) => update("youtube_download_dir", e.target.value)}
            className={`${FORM_CONTROL_CLS} min-h-[44px] min-w-0`}
          />
        </div>
        <p className="text-[12px] leading-5 text-[var(--text-3)]">{t("settings.youtube.downloadFolderHint")}</p>
      </div>

      <div className="space-y-1.5 md:max-w-[420px]">
        <label htmlFor={ids.notes} className={FORM_LABEL_CLS}>{t("settings.youtube.notesFolder")}</label>
        <input
          id={ids.notes}
          value={str(settings.youtube_notes_dir, "/notes")}
          onChange={(e) => update("youtube_notes_dir", e.target.value)}
          className={`${FORM_CONTROL_CLS} min-h-[44px] font-mono`}
        />
        {notes && (
          <StatusLine state={notes.writable ? { tone: "ok", text: t("settings.youtube.notesWritable") } : { tone: "warn", text: t("settings.youtube.notesMissing") }} />
        )}
      </div>

      <div className="space-y-1.5">
        <span className={FORM_LABEL_CLS}>{t("settings.youtube.downloader")}</span>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[13px] text-[var(--text)]">
            {ytdlp ? (ytdlp.available ? `yt-dlp ${ytdlp.version}` : t("settings.youtube.notInstalled")) : "…"}
          </span>
          <ActionButton variant="ghost" size="sm" onClick={() => void updateDownloader()} busy={updating} disabled={ytdlp?.available === false}>
            {updating ? t("settings.youtube.updating") : t("settings.youtube.updateNow")}
          </ActionButton>
        </div>
        {updateResult && <StatusLine state={updateResult} />}
      </div>
    </div>
  );
}
