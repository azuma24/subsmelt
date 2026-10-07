import { useId, useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../../i18n";
import * as api from "../../../api";
import { useConfirm } from "../../../ui/ConfirmModal";
import { useYoutubeNotesFolderQuery, useYoutubeStatusQuery } from "../../../hooks";
import { getErrorMessage } from "../../../lib";
import { str } from "../../../lib/settings-value";
import { FORM_CONTROL_CLS, FORM_LABEL_CLS } from "../../../ui/form-classes";
import { ActionButton } from "../../../ui/primitives";

// GET /api/settings returns this in place of a saved secret (REDACTED_SECRET in src/server/connections.ts).
const REDACTED_SECRET = "__SUBSMELT_SECRET_REDACTED__";

type KeyState = { tone: "off" | "ok" | "warn" | "bad"; text: string };

const TONE_CLS: Record<KeyState["tone"], string> = {
  off: "text-faint",
  ok: "text-success",
  warn: "text-warning",
  bad: "text-danger",
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
    <p role="status" className={`text-xs leading-5 ${TONE_CLS[state.tone]}`}>
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

  const keyState: KeyState =
    tested ??
    (apiKey
      ? { tone: "off", text: t("settings.youtube.keySaved") }
      : { tone: "off", text: t("settings.youtube.keyNotSet") });

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

  const notesDir = str(settings.youtube_notes_dir, "/notes").trim() || "/notes";
  const notes = useYoutubeNotesFolderQuery(notesDir).data;
  const ytdlp = statusQuery.data?.ytdlp;
  const cookies = statusQuery.data?.cookies;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label htmlFor={ids.key} className={FORM_LABEL_CLS}>
          {t("settings.youtube.apiKey")}{" "}
          <span className="font-normal text-faint">{t("settings.youtube.optional")}</span>
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
            className={`${FORM_CONTROL_CLS} min-h-touch min-w-0 flex-1 basis-[220px] font-mono`}
          />
          <ActionButton variant="ghost" size="sm" onClick={() => setShowKey((s) => !s)} disabled={keySaved || !apiKey}>
            {showKey ? t("settings.youtube.hide") : t("settings.youtube.show")}
          </ActionButton>
          <ActionButton variant="ghost" size="sm" onClick={() => void testKey()} busy={testing}>
            {testing ? t("common.testing") : t("settings.youtube.testKey")}
          </ActionButton>
        </div>
        <StatusLine state={keyState} />
        <p className="text-xs leading-5 text-faint">{t("settings.youtube.keyHint")}</p>
        <details className="text-xs leading-5 text-muted">
          <summary className="flex min-h-touch cursor-pointer items-center font-medium text-text">
            {t("settings.youtube.howTo")}
          </summary>
          <ol className="list-decimal space-y-1 pb-1 pl-6">
            {(["step1", "step2", "step3", "step4"] as const).map((step) => (
              <li key={step}>{t(`settings.youtube.${step}`)}</li>
            ))}
          </ol>
        </details>
      </div>

      <div className="space-y-2 md:max-w-[420px]">
        <label htmlFor={ids.download} className={FORM_LABEL_CLS}>
          {t("settings.youtube.downloadFolder")}
        </label>
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 max-w-[45%] shrink truncate font-mono text-xs text-faint"
            dir="rtl"
            title={str(settings._media_dir, "/media").replace(/\/+$/, "")}
          >
            <bdi>{str(settings._media_dir, "/media").replace(/\/+$/, "")}</bdi>
          </span>
          <span className="-ml-1 font-mono text-xs text-faint">/</span>
          <input
            id={ids.download}
            value={str(settings.youtube_download_dir, "YouTube")}
            onChange={(e) => update("youtube_download_dir", e.target.value)}
            className={`${FORM_CONTROL_CLS} min-h-touch min-w-0`}
          />
        </div>
        <p className="text-xs leading-5 text-faint">{t("settings.youtube.downloadFolderHint")}</p>
      </div>

      <div className="space-y-2 md:max-w-[420px]">
        <label htmlFor={ids.notes} className={FORM_LABEL_CLS}>
          {t("settings.youtube.notesFolder")}
        </label>
        <input
          id={ids.notes}
          value={str(settings.youtube_notes_dir, "/notes")}
          onChange={(e) => update("youtube_notes_dir", e.target.value)}
          className={`${FORM_CONTROL_CLS} min-h-touch font-mono`}
        />
        {notes && (
          <StatusLine
            state={
              notes.writable
                ? { tone: "ok", text: t("settings.youtube.notesWritable") }
                : {
                    tone: "warn",
                    text: t(notes.exists ? "settings.youtube.notesReadOnly" : "settings.youtube.notesMissing"),
                  }
            }
          />
        )}
      </div>

      <CookiesRow present={cookies?.present} updatedAt={cookies?.updatedAt ?? null} />

      <div className="space-y-2">
        <span className={FORM_LABEL_CLS}>{t("settings.youtube.downloader")}</span>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm text-text">
            {ytdlp ? (ytdlp.available ? `yt-dlp ${ytdlp.version}` : t("settings.youtube.notInstalled")) : "…"}
          </span>
          <ActionButton
            variant="ghost"
            size="sm"
            onClick={() => void updateDownloader()}
            busy={updating}
            disabled={ytdlp?.available === false}
          >
            {updating ? t("settings.youtube.updating") : t("settings.youtube.updateNow")}
          </ActionButton>
        </div>
        {updateResult && <StatusLine state={updateResult} />}
      </div>
    </div>
  );
}

/** Upload or remove cookies.txt. The server only ever reports whether a file is there and since when. */
function CookiesRow({ present, updatedAt }: { present: boolean | undefined; updatedAt: string | null }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeyState | null>(null);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      setResult({ tone: "ok", text: done });
      await queryClient.invalidateQueries({ queryKey: ["youtube", "status"] });
    } catch (error) {
      setResult({ tone: "bad", text: t("settings.youtube.cookiesFailed", { error: getErrorMessage(error) }) });
    }
    setBusy(false);
  };

  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void run(async () => api.uploadYoutubeCookies(await file.text()), t("settings.youtube.cookiesSaved"));
  };

  const remove = async () => {
    const ok = await confirm({
      title: t("settings.youtube.cookiesRemoveTitle"),
      message: t("settings.youtube.cookiesRemoveMessage"),
      confirmLabel: t("settings.youtube.cookiesRemove"),
      danger: true,
    });
    if (ok) void run(api.removeYoutubeCookies, t("settings.youtube.cookiesRemoved"));
  };

  const state: KeyState = present
    ? {
        tone: "ok",
        text: t("settings.youtube.cookiesPresent", {
          date: updatedAt ? new Date(updatedAt).toLocaleDateString(i18n.language, { dateStyle: "medium" }) : "",
        }),
      }
    : { tone: "off", text: t("settings.youtube.cookiesAbsent") };

  return (
    <div className="space-y-2" role="group" aria-labelledby={labelId}>
      <span id={labelId} className={FORM_LABEL_CLS}>
        {t("settings.youtube.cookies")} <span className="font-normal text-faint">{t("settings.youtube.optional")}</span>
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={upload} />
        <ActionButton
          variant="ghost"
          size="sm"
          onClick={() => fileRef.current?.click()}
          busy={busy}
          disabled={present === undefined}
        >
          {present ? t("settings.youtube.cookiesReplace") : t("settings.youtube.cookiesUpload")}
        </ActionButton>
        {present && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="min-h-touch rounded-sm px-3 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
          >
            {t("settings.youtube.cookiesRemove")}
          </button>
        )}
      </div>
      <StatusLine state={result ?? state} />
      <p className="text-xs leading-5 text-faint">{t("settings.youtube.cookiesHint")}</p>
    </div>
  );
}
