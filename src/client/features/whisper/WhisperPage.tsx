import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as api from "../../api";
import {
  useMutationWithInvalidation,
  useSettingsQuery,
  useTranscriptionHealthQuery,
  useTranscriptionHistoryQuery,
} from "../../hooks";
import type { TranscriptionHistoryEntry } from "../../types";
import { TranscriptionReadinessPanel } from "../settings/TranscriptionReadinessPanel";
import { ModelManagerPanel } from "../settings/ModelManagerPanel";
import { TranscriptionHistoryPanel } from "../dashboard/TranscriptionHistoryPanel";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/**
 * Dedicated Whisper / speech-to-text hub. Surfaces backend readiness, the model
 * manager, and recent transcription history in one place — separate from the
 * translation flow. Per-file/batch transcription itself still lives on the
 * Dashboard scan list (where the video files are listed).
 */
export function WhisperPage({ isMobile = false }: { isMobile?: boolean }) {
  const { t } = useTranslation();
  const settingsQuery = useSettingsQuery();
  const settings = (settingsQuery.data ?? {}) as Record<string, unknown>;
  const backendConfigured = Boolean(str(settings.transcription_backend_url));
  const enabled = str(settings.transcription_enabled, "0") === "1";

  const healthQuery = useTranscriptionHealthQuery(backendConfigured);
  const historyQuery = useTranscriptionHistoryQuery(true, 20);
  const attempts = historyQuery.data?.attempts ?? [];

  const retryMutation = useMutationWithInvalidation((id: string) => api.retryTranscriptionAttempt(id));
  const onRetry = (attempt: TranscriptionHistoryEntry) => {
    retryMutation.mutate(attempt.id);
  };

  return (
    <div className={`mx-auto w-full max-w-[1100px] space-y-4 ${isMobile ? "p-3 pb-24" : "p-5"}`}>
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">{t("whisper.title")}</h1>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">{t("whisper.subtitle")}</p>
      </div>

      {!enabled && (
        <div className="rounded-2xl border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-4 py-3 text-[13px] text-[var(--yellow)]">
          {t("whisper.disabledNotice")}{" "}
          <Link to="/settings" className="underline">{t("whisper.openSettings")}</Link>
        </div>
      )}

      <TranscriptionReadinessPanel settings={settings} healthQuery={healthQuery} dirty={false} />

      <ModelManagerPanel enabled={backendConfigured} />

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
        <TranscriptionHistoryPanel
          attempts={attempts}
          transcribingPath={null}
          isRetryPending={retryMutation.isPending}
          isTranscribePending={false}
          onRetry={onRetry}
        />
      </section>

      <p className="text-[12px] text-[var(--text-3)]">{t("whisper.transcribeHint")}</p>
    </div>
  );
}
