import { useTranslation } from "react-i18next";
import { Accordion, Field } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { ToggleRow, labelCls, selectCls } from "./shared";

interface SttAdvancedFieldsProps {
  settings: Record<string, unknown>;
  isMobile: boolean;
  /** Deferred writer — every control here is persisted by the topbar Save. */
  update: (key: string, value: unknown) => void;
}

/**
 * Device/compute/concurrency, line shaping, VAD and the two fallback
 * behaviours. Collapsed by default, like every other "Advanced" accordion.
 */
export function SttAdvancedFields({ settings, isMobile, update }: SttAdvancedFieldsProps) {
  const { t } = useTranslation();
  return (
    <Accordion title={t("settings.advanced")}>
      <div className="space-y-4">
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
          <Field label={t("settings.transcription.device")} value={str(settings.transcription_device, "cpu")} onChange={(v) => update("transcription_device", v)} help={t("settings.transcription.deviceHelp")} />
          <Field label={t("settings.transcription.computeType")} value={str(settings.transcription_compute_type, "int8")} onChange={(v) => update("transcription_compute_type", v)} help={t("settings.transcription.computeTypeHelp")} />
          <Field label={t("settings.transcription.maxConcurrent")} value={str(settings.transcription_max_concurrent, "1")} onChange={(v) => update("transcription_max_concurrent", v)} type="number" help={t("settings.transcription.maxConcurrentHelp")} />
        </div>
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
          <Field label={t("settings.transcription.maxLineLength")} value={str(settings.transcription_max_line_length, "42")} onChange={(v) => update("transcription_max_line_length", v)} type="number" help={t("settings.transcription.maxLineLengthHelp")} />
          <Field label={t("settings.transcription.maxSubtitleDuration")} value={str(settings.transcription_max_subtitle_duration, "6")} onChange={(v) => update("transcription_max_subtitle_duration", v)} type="number" help={t("settings.transcription.maxSubtitleDurationHelp")} />
          <div className="flex items-end">
            <ToggleRow
              title={t("settings.transcription.mergeShortSegments")}
              description={t("settings.transcription.mergeShortSegmentsHelp")}
              checked={str(settings.transcription_merge_short_segments, "0") === "1"}
              onChange={(checked) => update("transcription_merge_short_segments", checked ? "1" : "0")}
            />
          </div>
        </div>
        <ToggleRow
          title={t("settings.transcription.useVad")}
          description={t("settings.transcription.useVadHelp")}
          checked={str(settings.transcription_use_vad, "1") === "1"}
          onChange={(checked) => update("transcription_use_vad", checked ? "1" : "0")}
        />
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
          <div>
            <label className={labelCls}>{t("settings.transcription.missingSubtitleBehavior")}</label>
            <select aria-label={t("settings.transcription.missingSubtitleBehavior")} value={str(settings.transcription_missing_subtitle_behavior, "ask")} onChange={(e) => update("transcription_missing_subtitle_behavior", e.target.value)} className={selectCls}>
              <option value="ask">{t("settings.transcription.missingAsk")}</option>
              <option value="auto_transcribe">{t("settings.transcription.missingAutoTranscribe")}</option>
              <option value="auto_transcribe_and_translate">{t("settings.transcription.missingAutoTranscribeTranslate")}</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>{t("settings.transcription.lowRamBehavior")}</label>
            <select aria-label={t("settings.transcription.lowRamBehavior")} value={str(settings.transcription_low_ram_behavior, "ask")} onChange={(e) => update("transcription_low_ram_behavior", e.target.value)} className={selectCls}>
              <option value="ask">{t("settings.transcription.lowRamAsk")}</option>
              <option value="downgrade">{t("settings.transcription.lowRamDowngrade")}</option>
              <option value="skip">{t("settings.transcription.lowRamSkip")}</option>
              <option value="run_anyway">{t("settings.transcription.lowRamRunAnyway")}</option>
            </select>
          </div>
        </div>
      </div>
    </Accordion>
  );
}
