import { useTranslation } from "../../../i18n";
import { Accordion, Field, Select } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { ToggleRow, labelCls } from "./shared";
import type { WhisperModelDescriptor } from "../../../types";
import { hidesOptions } from "../../whisper/whisper-shared";
import { OptionsDecidedNote } from "../../whisper/ModelPicker";
import { useIsMobile } from "../../../hooks";

interface SttAdvancedFieldsProps {
  settings: Record<string, unknown>;
  /** Deferred writer — every control here is persisted by the topbar Save. */
  update: (key: string, value: unknown) => void;
  /** The default model; options it decides itself are hidden. */
  model: WhisperModelDescriptor;
}

/**
 * Device/compute/concurrency, line shaping, VAD and the two fallback
 * behaviours. Collapsed by default, like every other "Advanced" accordion.
 */
export function SttAdvancedFields({ settings, update, model }: SttAdvancedFieldsProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  return (
    <Accordion title={t("settings.advanced")}>
      <div className="space-y-4">
        {hidesOptions(model) && <OptionsDecidedNote model={model} />}
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
          <Field
            label={t("settings.transcription.device")}
            value={str(settings.transcription_device, "cpu")}
            onChange={(v) => update("transcription_device", v)}
            help={t("settings.transcription.deviceHelp")}
          />
          {model.supports.computeType && (
            <Field
              label={t("settings.transcription.computeType")}
              value={str(settings.transcription_compute_type, "int8")}
              onChange={(v) => update("transcription_compute_type", v)}
              help={t("settings.transcription.computeTypeHelp")}
            />
          )}
          <Field
            label={t("settings.transcription.maxConcurrent")}
            value={str(settings.transcription_max_concurrent, "1")}
            onChange={(v) => update("transcription_max_concurrent", v)}
            type="number"
            min={1}
            max={4}
            help={t("settings.transcription.maxConcurrentHelp")}
          />
        </div>
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
          <Field
            label={t("settings.transcription.maxLineLength")}
            value={str(settings.transcription_max_line_length, "42")}
            onChange={(v) => update("transcription_max_line_length", v)}
            type="number"
            min={0}
            max={200}
            help={t("settings.transcription.maxLineLengthHelp")}
          />
          <Field
            label={t("settings.transcription.maxSubtitleDuration")}
            value={str(settings.transcription_max_subtitle_duration, "6")}
            onChange={(v) => update("transcription_max_subtitle_duration", v)}
            type="number"
            min={0}
            max={60}
            step="any"
            help={t("settings.transcription.maxSubtitleDurationHelp")}
          />
          <div className="flex items-end">
            <ToggleRow
              title={t("settings.transcription.mergeShortSegments")}
              description={t("settings.transcription.mergeShortSegmentsHelp")}
              checked={str(settings.transcription_merge_short_segments, "0") === "1"}
              onChange={(checked) => update("transcription_merge_short_segments", checked ? "1" : "0")}
            />
          </div>
        </div>
        {model.supports.vad && (
          <ToggleRow
            title={t("settings.transcription.useVad")}
            description={t("settings.transcription.useVadHelp")}
            checked={str(settings.transcription_use_vad, "1") === "1"}
            onChange={(checked) => update("transcription_use_vad", checked ? "1" : "0")}
          />
        )}
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
          <div>
            <label className={labelCls}>{t("settings.transcription.missingSubtitleBehavior")}</label>
            <Select
              ariaLabel={t("settings.transcription.missingSubtitleBehavior")}
              value={str(settings.transcription_missing_subtitle_behavior, "ask")}
              onChange={(value) => update("transcription_missing_subtitle_behavior", value)}
            >
              <option value="ask">{t("settings.transcription.missingAsk")}</option>
              <option value="auto_transcribe">{t("settings.transcription.missingAutoTranscribe")}</option>
              <option value="auto_transcribe_and_translate">
                {t("settings.transcription.missingAutoTranscribeTranslate")}
              </option>
            </Select>
          </div>
          <div>
            <label className={labelCls}>{t("settings.transcription.lowRamBehavior")}</label>
            <Select
              ariaLabel={t("settings.transcription.lowRamBehavior")}
              value={str(settings.transcription_low_ram_behavior, "ask")}
              onChange={(value) => update("transcription_low_ram_behavior", value)}
            >
              <option value="ask">{t("settings.transcription.lowRamAsk")}</option>
              <option value="downgrade">{t("settings.transcription.lowRamDowngrade")}</option>
              <option value="skip">{t("settings.transcription.lowRamSkip")}</option>
              <option value="run_anyway">{t("settings.transcription.lowRamRunAnyway")}</option>
            </Select>
          </div>
        </div>
      </div>
    </Accordion>
  );
}
