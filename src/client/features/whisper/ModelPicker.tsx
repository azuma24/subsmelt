import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { WhisperModelDescriptor } from "../../types";
import { findDescriptor, groupByEngine, MODEL_LABEL_KEYS, supportsLanguage } from "./whisper-shared";
import { Icon } from "../../ui/Icon";

export function modelLabel(t: TFunction, model: WhisperModelDescriptor): string {
  const key = MODEL_LABEL_KEYS[model.id];
  return key ? t(key) : model.label;
}

interface ModelPickerProps {
  descriptors: WhisperModelDescriptor[];
  value: string;
  onChange: (modelId: string) => void;
  className: string;
  ariaLabel?: string;
  /** Downloaded state per model, when the caller has the model list. */
  isDownloaded?: (modelId: string) => boolean | undefined;
}

/**
 * Speech-to-text model select, grouped by engine, with the selected engine's
 * strength underneath. A model whose runtime is missing stays listed but
 * cannot be picked.
 */
export function ModelPicker({ descriptors, value, onChange, className, ariaLabel, isDownloaded }: ModelPickerProps) {
  const { t } = useTranslation();
  const selected = findDescriptor(descriptors, value);
  const listed = descriptors.some((d) => d.id === value) ? descriptors : [selected, ...descriptors];

  const suffix = (model: WhisperModelDescriptor): string => {
    if (!model.available) return ` — ${t("settings.models.runtimeMissing")}`;
    if (isDownloaded?.(model.id) === false) return ` — ${t("settings.models.notDownloaded")}`;
    return "";
  };

  return (
    <>
      <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
        {groupByEngine(listed).map((group) => (
          <optgroup key={group.engine} label={t(`stt.engine.${group.engine}`)}>
            {group.items.map((model) => (
              <option key={model.id} value={model.id} disabled={!model.available}>
                {modelLabel(t, model)}
                {suffix(model)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <p className="mt-1 text-xs leading-snug text-faint">{t(`stt.engineStrength.${selected.engine}`)}</p>
      {!selected.available && (
        <p className="mt-1 text-xs leading-snug text-danger">
          <Icon name="error" />
          {t("stt.modelUnavailable", {
            model: selected.label,
            reason: selected.unavailableReason ?? t("settings.models.runtimeMissing"),
          })}
        </p>
      )}
    </>
  );
}

/** Warns when the chosen language is outside the selected model's language list. */
export function LanguageSupportWarning({ model, language }: { model: WhisperModelDescriptor; language: string }) {
  const { t } = useTranslation();
  if (supportsLanguage(model, language)) return null;
  return (
    <p className="mt-1 text-xs leading-snug text-warning">
      <Icon name="warning" />
      {t("stt.languageUnsupported", { model: model.label, language })}
    </p>
  );
}

/** Shown where options were hidden because the selected model decides them. */
export function OptionsDecidedNote({ model }: { model: WhisperModelDescriptor }) {
  const { t } = useTranslation();
  return <p className="text-xs leading-snug text-faint">{t("stt.optionsDecidedByModel", { model: model.label })}</p>;
}
