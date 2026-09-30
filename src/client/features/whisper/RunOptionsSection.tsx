import { useTranslation } from "react-i18next";
import { Accordion, ProgressSmall, SettingsSection } from "../../ui/primitives";
import type { WhisperModelDescriptor } from "../../types";
import type { ModelDownloadProgress } from "../../hooks";
import { COMMON_LANGS, findDescriptor, FORMATS, hidesOptions, selectCls, type OutputFormat } from "./whisper-shared";
import { LanguageSupportWarning, ModelPicker, OptionsDecidedNote } from "./ModelPicker";

export interface RunOptionsSectionProps {
  isMobile: boolean;
  modelDescriptors: WhisperModelDescriptor[];
  effModel: string;
  onModelChange: (modelId: string) => Promise<void>;
  isModelDownloaded: (modelId: string) => boolean | undefined;
  modelDownloads: Record<string, ModelDownloadProgress>;
  effLang: string;
  onLanguageChange: (value: string) => void;
  effFormat: OutputFormat;
  onFormatChange: (value: string) => void;
  effDevice: string;
  onDeviceChange: (value: string) => void;
  deviceOptions: string[];
  effCompute: string;
  onComputeChange: (value: string) => void;
  computeOptions: string[];
  canDiarize: boolean;
  effDiarize: boolean;
  onDiarizeChange: (checked: boolean) => void;
  /** Whether backend capabilities have loaded yet (controls the diarize-unavailable tooltip). */
  hasCaps: boolean;
}

const optionLabelCls = "flex flex-col gap-1 text-[11px] text-[var(--text-2)]";

/**
 * "Run options" settings section. Everyday knobs (model/language/format) stay
 * visible; device/compute/diarize are expert settings and live behind the
 * Advanced disclosure. Also renders model-download progress rows.
 */
export function RunOptionsSection({
  isMobile, modelDescriptors, effModel, onModelChange, isModelDownloaded, modelDownloads,
  effLang, onLanguageChange, effFormat, onFormatChange, effDevice, onDeviceChange, deviceOptions,
  effCompute, onComputeChange, computeOptions, canDiarize, effDiarize, onDiarizeChange, hasCaps,
}: RunOptionsSectionProps) {
  const { t } = useTranslation();
  const selectedModel = findDescriptor(modelDescriptors, effModel);
  const languages = COMMON_LANGS.includes(effLang) ? COMMON_LANGS : [...COMMON_LANGS, effLang];

  return (
    <SettingsSection title={t("whisper.runOptions")} description={t("whisper.runOptionsHint")}>
      <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
        <label className={optionLabelCls}>{t("whisper.model")}
          <ModelPicker
            descriptors={modelDescriptors}
            value={effModel}
            onChange={(modelId) => { void onModelChange(modelId); }}
            className={selectCls}
            isDownloaded={isModelDownloaded}
          />
          {/* Not-downloaded badge for the currently-selected model */}
          {isModelDownloaded(effModel) === false && modelDownloads[effModel]?.active !== true && (
            <span className="text-[10px] text-[var(--yellow)]"><span aria-hidden="true">⚠ </span>{t("settings.models.notDownloaded")}</span>
          )}
        </label>
        <label className={optionLabelCls}>{t("whisper.language")}
          <select value={effLang} onChange={(e) => onLanguageChange(e.target.value)} className={selectCls}>
            {languages.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <LanguageSupportWarning model={selectedModel} language={effLang} />
        </label>
        <label className={optionLabelCls}>{t("whisper.format")}
          <select value={effFormat} onChange={(e) => onFormatChange(e.target.value)} className={selectCls}>
            {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        </label>
      </div>

      <Accordion title={t("whisper.advancedOptions")}>
        {hidesOptions(selectedModel) && <div className="mb-3"><OptionsDecidedNote model={selectedModel} /></div>}
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
          <label className={optionLabelCls}>{t("whisper.device")}
            <select value={effDevice} onChange={(e) => onDeviceChange(e.target.value)} className={selectCls}>
              {deviceOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          {selectedModel.supports.computeType && (
            <label className={optionLabelCls}>{t("whisper.compute")}
              <select value={effCompute} onChange={(e) => onComputeChange(e.target.value)} className={selectCls}>
                {computeOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          {canDiarize ? (
            <label className="flex items-center gap-2 self-end pb-2 text-[11px] text-[var(--text-2)]">
              <input type="checkbox" checked={effDiarize} onChange={(e) => onDiarizeChange(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
              {t("whisper.diarize")}
            </label>
          ) : (
            // Render the disabled row even while capabilities are still
            // loading, so the control doesn't flicker into existence.
            <label
              className="flex items-center gap-2 self-end pb-2 text-[11px] text-[var(--text-3)] opacity-60"
              title={hasCaps ? t("whisper.diarizeUnavailable") : t("common.loading")}
            >
              <input type="checkbox" disabled className="h-4 w-4" />
              {t("whisper.diarize")}
            </label>
          )}
        </div>
      </Accordion>

      {/* Model download progress — shown when a model is being downloaded */}
      {Object.entries(modelDownloads).filter(([, dl]) => dl.active).map(([modelId, dl]) => (
        <div key={modelId} className="flex items-center gap-3 rounded-lg border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-3 py-2">
          <span className="text-[11px] text-[var(--yellow)] shrink-0">{t("whisper.modelDownloading", { model: modelId })}</span>
          <div className="flex-1"><ProgressSmall pct={dl.pct} large /></div>
        </div>
      ))}
    </SettingsSection>
  );
}
