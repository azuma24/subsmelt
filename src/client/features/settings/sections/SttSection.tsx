import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TranscriptionHealth } from "../../../types";
import { ActionButton, Field } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { isEnvPinned } from "../settings-model";
import { ModelManagerPanel } from "../ModelManagerPanel";
import { TranscriptionReadinessPanel } from "../TranscriptionReadinessPanel";
import { PathMappingFields } from "./PathMappingFields";
import { RawConfigDrawer } from "./RawConfigDrawer";
import { SttAdvancedFields } from "./SttAdvancedFields";
import { descriptorsFrom, findDescriptor } from "../../whisper/whisper-shared";
import { LanguageSupportWarning, ModelPicker } from "../../whisper/ModelPicker";
import { ToggleRow, labelCls, selectCls } from "./shared";

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

  // Before health loads this falls back to the known Whisper sizes; the picker
  // always lists the saved model so a value like large-v3 is never dropped.
  const modelDescriptors = descriptorsFrom(healthQuery.data?.health?.capabilities);
  const selectedSttModel = str(settings.transcription_model, "small");
  const selectedDescriptor = findDescriptor(modelDescriptors, selectedSttModel);
  const selectedLanguage = str(settings.transcription_language, "auto");
  const languageOptions = STT_LANGUAGE_OPTIONS.some((opt) => opt.value === selectedLanguage)
    ? STT_LANGUAGE_OPTIONS
    : [...STT_LANGUAGE_OPTIONS, { value: selectedLanguage, labelKey: "" }];

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
          readOnly={isEnvPinned(settings, "transcription_backend_url")}
          help={isEnvPinned(settings, "transcription_backend_url") ? t("settings.envPinnedNote", { name: "WHISPER_BACKEND_URL" }) : t("settings.transcription.backendUrlHelp")}
        />
      </div>
      <div className="md:max-w-[340px]">
        <Field
          label={t("settings.transcription.backendToken")}
          value={str(settings.transcription_backend_token)}
          onChange={(v) => updateAndSaveDebounced("transcription_backend_token", v)}
          type="password"
          placeholder="••••••••"
          readOnly={isEnvPinned(settings, "transcription_backend_token")}
          help={isEnvPinned(settings, "transcription_backend_token") ? t("settings.envPinnedNote", { name: "WHISPER_BACKEND_TOKEN" }) : t("settings.transcription.backendTokenHelp")}
        />
      </div>
      <div className={`flex ${isMobile ? "flex-col" : "items-center"} gap-3`}>
        <ActionButton variant="ghost" size="sm" onClick={onTest}>{testing ? t("app.testing") : t("settings.transcription.testButton")}</ActionButton>
        {testResult && (
          <span className={`text-sm ${testResult.ok ? "text-success" : "text-danger"}`}><span aria-hidden="true">{testResult.ok ? "✓ " : "✗ "}</span>{testResult.message}</span>
        )}
      </div>
      <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
        <div>
          <label className={labelCls}>{t("settings.transcription.model")}</label>
          <ModelPicker
            ariaLabel={t("settings.transcription.model")}
            descriptors={modelDescriptors}
            value={selectedSttModel}
            onChange={(modelId) => update("transcription_model", modelId)}
            className={selectCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t("settings.transcription.language")}</label>
          <select aria-label={t("settings.transcription.language")} value={selectedLanguage} onChange={(e) => update("transcription_language", e.target.value)} className={selectCls}>
            {languageOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.labelKey ? t(opt.labelKey) : opt.value}</option>
            ))}
          </select>
          <LanguageSupportWarning model={selectedDescriptor} language={selectedLanguage} />
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
      <ToggleRow
        title={t("settings.transcription.gpuSharedLabel")}
        description={t("settings.transcription.gpuSharedHelp")}
        checked={str(settings.gpu_shared, "0") === "1"}
        onChange={(checked) => update("gpu_shared", checked ? "1" : "0")}
      />
      <TranscriptionReadinessPanel settings={settings} healthQuery={healthQuery} dirty={dirty} />

      {/* Speech-to-text model manager — proxied to the configured backend. Requires a
          backend URL to be set; download progress streams over SSE. */}
      <ModelManagerPanel enabled={Boolean(str(settings.transcription_backend_url))} />

      <PathMappingFields settings={settings} isMobile={isMobile} update={update} />

      <SttAdvancedFields settings={settings} isMobile={isMobile} update={update} model={selectedDescriptor} />

      {/* Raw config (L4) — the two STT JSON blobs, behind an explicit Save. */}
      <RawConfigDrawer settings={settings} update={update} onSave={onSave} dirty={dirty} saving={saving} />
    </>
  );
}
