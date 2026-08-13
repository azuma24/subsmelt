import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TranscriptionHealth } from "../../../types";
import { ActionButton, Field } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { ModelManagerPanel } from "../ModelManagerPanel";
import { TranscriptionReadinessPanel } from "../TranscriptionReadinessPanel";
import { PathMappingFields } from "./PathMappingFields";
import { RawConfigDrawer } from "./RawConfigDrawer";
import { SttAdvancedFields } from "./SttAdvancedFields";
import { ToggleRow, labelCls, selectCls } from "./shared";

// Model options are driven by the backend's advertised capabilities.models so
// the dropdown always matches what the server (and the model manager) support.
// Falls back to the full known set before health loads, and always includes the
// currently-selected model so a saved value (e.g. large-v3) can't be dropped.
const STT_MODEL_FALLBACK = ["tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3", "distil-large-v3", "large-v3-turbo"];

const STT_MODEL_LABEL_KEYS: Record<string, string> = {
  tiny: "settings.transcription.modelTiny",
  base: "settings.transcription.modelBase",
  small: "settings.transcription.modelSmall",
  medium: "settings.transcription.modelMedium",
  "large-v1": "settings.transcription.modelLargeV1",
  "large-v2": "settings.transcription.modelLargeV2",
  "large-v3": "settings.transcription.modelLargeV3",
  "distil-large-v3": "settings.transcription.modelDistilLargeV3",
  "large-v3-turbo": "settings.transcription.modelLargeV3Turbo",
};

/** Whisper's source-language shortlist. `auto` plus the four bundled hints. */
const STT_LANGUAGE_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "auto", labelKey: "settings.transcription.languageAuto" },
  { value: "en", labelKey: "settings.transcription.languageEnglish" },
  { value: "ja", labelKey: "settings.transcription.languageJapanese" },
  { value: "zh", labelKey: "settings.transcription.languageChinese" },
  { value: "ko", labelKey: "settings.transcription.languageKorean" },
];

interface SttSectionProps {
  settings: Record<string, unknown>;
  isMobile: boolean;
  /** Deferred writer — most of this section waits for the topbar Save. */
  update: (key: string, value: unknown) => void;
  /** Debounced autosave — used only by the backend token, as before. */
  updateAndSaveDebounced: (key: string, value: unknown) => void;
  healthQuery: UseQueryResult<TranscriptionHealth>;
  dirty: boolean;
  saving: boolean;
  onSave: () => Promise<boolean>;
  onTest: () => void;
  testing: boolean;
  testResult: { ok: boolean; message: string } | null;
}

/**
 * Speech-to-Text. Historically the densest inline block on the page (~186
 * lines); the path-mapping, advanced and raw-config groups now live in their
 * own files.
 *
 * Save mechanics are unchanged: every field uses the deferred `update` writer
 * and is committed by the topbar Save button — with the single exception of the
 * backend token, which autosaves on a debounce exactly as it did inline.
 */
export function SttSection({
  settings,
  isMobile,
  update,
  updateAndSaveDebounced,
  healthQuery,
  dirty,
  saving,
  onSave,
  onTest,
  testing,
  testResult,
}: SttSectionProps) {
  const { t } = useTranslation();

  const advertisedModels = healthQuery.data?.health?.capabilities?.models;
  const selectedSttModel = str(settings.transcription_model, "small");
  const sttModelOptions = (() => {
    const base = advertisedModels && advertisedModels.length ? [...advertisedModels] : [...STT_MODEL_FALLBACK];
    if (!base.includes(selectedSttModel)) base.unshift(selectedSttModel);
    return base;
  })();

  return (
    <>
      <ToggleRow
        title={t("settings.transcription.enableLabel")}
        description={t("settings.transcription.enableHelp")}
        checked={str(settings.transcription_enabled, "0") === "1"}
        onChange={(checked) => update("transcription_enabled", checked ? "1" : "0")}
      />
      <div className="md:max-w-[340px]">
        <Field
          label={t("settings.transcription.backendUrl")}
          value={str(settings.transcription_backend_url)}
          onChange={(v) => update("transcription_backend_url", v)}
          placeholder="http://whisper-backend:8001"
          help={t("settings.transcription.backendUrlHelp")}
        />
      </div>
      <div className="md:max-w-[340px]">
        <Field
          label={t("settings.transcription.backendToken")}
          value={str(settings.transcription_backend_token)}
          onChange={(v) => updateAndSaveDebounced("transcription_backend_token", v)}
          type="password"
          placeholder="••••••••"
          help={t("settings.transcription.backendTokenHelp")}
        />
      </div>
      <div className={`flex ${isMobile ? "flex-col" : "items-center"} gap-3`}>
        <ActionButton variant="ghost" size="sm" onClick={onTest}>{testing ? t("app.testing") : t("settings.transcription.testButton")}</ActionButton>
        {testResult && (
          <span className={`text-[13px] ${testResult.ok ? "text-[var(--green)]" : "text-[var(--red)]"}`}><span aria-hidden="true">{testResult.ok ? "✓ " : "✗ "}</span>{testResult.message}</span>
        )}
      </div>
      <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
        <div>
          <label className={labelCls}>{t("settings.transcription.model")}</label>
          <select aria-label={t("settings.transcription.model")} value={selectedSttModel} onChange={(e) => update("transcription_model", e.target.value)} className={selectCls}>
            {sttModelOptions.map((m) => (
              <option key={m} value={m}>{STT_MODEL_LABEL_KEYS[m] ? t(STT_MODEL_LABEL_KEYS[m]) : m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{t("settings.transcription.language")}</label>
          <select aria-label={t("settings.transcription.language")} value={str(settings.transcription_language, "auto")} onChange={(e) => update("transcription_language", e.target.value)} className={selectCls}>
            {STT_LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{t("settings.transcription.output")}</label>
          <select aria-label={t("settings.transcription.output")} value={str(settings.transcription_output_format, "srt")} onChange={(e) => update("transcription_output_format", e.target.value)} className={selectCls}>
            <option value="srt">SRT</option>
            <option value="vtt">VTT</option>
            <option value="txt">TXT</option>
          </select>
        </div>
      </div>
      <TranscriptionReadinessPanel settings={settings} healthQuery={healthQuery} dirty={dirty} />

      {/* Whisper model manager — proxied to the configured backend. Requires a
          backend URL to be set; download progress streams over SSE. */}
      <ModelManagerPanel enabled={Boolean(str(settings.transcription_backend_url))} />

      <PathMappingFields settings={settings} isMobile={isMobile} update={update} />

      <SttAdvancedFields settings={settings} isMobile={isMobile} update={update} />

      {/* Raw config (L4) — the two STT JSON blobs, behind an explicit Save. */}
      <RawConfigDrawer settings={settings} update={update} onSave={onSave} dirty={dirty} saving={saving} />
    </>
  );
}
