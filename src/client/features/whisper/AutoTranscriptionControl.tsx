import { useState } from "react";
import * as api from "../../api";
import { useTranslation } from "../../i18n";
import { useMutationWithInvalidation } from "../../hooks";
import { getErrorMessage } from "../../lib";
import { str } from "../../lib/settings-value";
import { useToast } from "../../ui/Toast";
import { Select, SettingsSection } from "../../ui/primitives";

const DEFAULT_SCAN_MINUTES = "30";
const BEHAVIORS = ["ask", "auto_transcribe", "auto_transcribe_and_translate"] as const;
type Behavior = (typeof BEHAVIORS)[number];

export function autoTranscriptionPatch(next: Behavior, currentInterval: unknown): Record<string, string> {
  const interval = Number(currentInterval);
  return {
    transcription_missing_subtitle_behavior: next,
    ...(next !== "ask" && (!Number.isFinite(interval) || interval <= 0)
      ? { auto_scan_interval: DEFAULT_SCAN_MINUTES }
      : {}),
  };
}

export function AutoTranscriptionControl({ settings }: { settings: Record<string, unknown> }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [pending, setPending] = useState<Behavior | null>(null);
  const save = useMutationWithInvalidation((patch: Record<string, string>) => api.saveSettings(patch));
  const saved = str(settings.transcription_missing_subtitle_behavior, "ask");
  const behavior = pending ?? (BEHAVIORS.includes(saved as Behavior) ? (saved as Behavior) : "ask");

  const change = async (next: string) => {
    if (!BEHAVIORS.includes(next as Behavior) || save.isPending) return;
    const previous = behavior;
    setPending(next as Behavior);
    // Auto mode must schedule actual server scans, not only change the behavior
    // used by a manually triggered scan. Preserve an existing custom interval.
    try {
      await save.mutateAsync(autoTranscriptionPatch(next as Behavior, settings.auto_scan_interval));
    } catch (error) {
      setPending(previous);
      addToast(getErrorMessage(error), "error");
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingsSection title={t("settings.transcription.missingSubtitleBehavior")}>
      <Select
        ariaLabel={t("settings.transcription.missingSubtitleBehavior")}
        value={behavior}
        disabled={save.isPending}
        onChange={(value) => void change(value)}
      >
        <option value="ask">{t("settings.transcription.missingAsk")}</option>
        <option value="auto_transcribe">{t("settings.transcription.missingAutoTranscribe")}</option>
        <option value="auto_transcribe_and_translate">
          {t("settings.transcription.missingAutoTranscribeTranslate")}
        </option>
      </Select>
      {behavior !== "ask" && (
        <p className="mt-2 text-xs text-muted">
          {t("settings.sources.autoScanInterval")}: {str(settings.auto_scan_interval, DEFAULT_SCAN_MINUTES)}
        </p>
      )}
    </SettingsSection>
  );
}
