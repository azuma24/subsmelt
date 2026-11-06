import { useState } from "react";
import { parseProcessingProfiles, type ProcessingProfile } from "../../../../shared/processing-profiles";
import { parseCorrectionRuleSets } from "../../../../shared/corrections";
import { useTranslation } from "../../../i18n";
import { str } from "../../../lib/settings-value";
import type { Task } from "../../../types";
import { ActionButton, Field, Select, SettingsSection } from "../../../ui/primitives";
import { ToggleRow } from "./shared";
import { createProfileId } from "../media-sources/model";

function profilesFrom(value: string): ProcessingProfile[] {
  try {
    return parseProcessingProfiles(value);
  } catch {
    return [];
  }
}

export function ProcessingProfilesSection({
  settings,
  tasks,
  update,
}: {
  settings: Record<string, unknown>;
  tasks: Task[];
  update: (key: string, value: unknown) => void;
}) {
  const { t } = useTranslation();
  const profiles = profilesFrom(str(settings.processing_profiles, "[]"));
  const correctionLists = parseCorrectionRuleSets(str(settings.correction_rule_sets, "[]"));
  const [draft, setDraft] = useState<ProcessingProfile | null>(null);
  const [error, setError] = useState(false);
  const edit = (patch: Partial<ProcessingProfile>) => {
    setDraft((current) => current && { ...current, ...patch });
    setError(false);
  };
  const save = () => {
    if (!draft) return;
    const updated = profiles.some((item) => item.id === draft.id)
      ? profiles.map((item) => (item.id === draft.id ? draft : item))
      : [...profiles, draft];
    const value = JSON.stringify(updated);
    try {
      parseProcessingProfiles(value);
      update("processing_profiles", value);
      setDraft(null);
    } catch {
      setError(true);
    }
  };

  return (
    <SettingsSection title={t("processing.profiles")} description={t("processing.profilesHelp")}>
      <ul className="space-y-2">
        {profiles.map((profile) => (
          <li
            key={profile.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">{profile.name}</p>
              <p className="break-words text-xs text-muted">{profile.folder || t("processing.root")}</p>
            </div>
            <div className="flex gap-2">
              <ActionButton
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(profile);
                  setError(false);
                }}
              >
                {t("common.edit")}
              </ActionButton>
              <ActionButton
                size="sm"
                variant="ghost"
                onClick={() => {
                  update("processing_profiles", JSON.stringify(profiles.filter((item) => item.id !== profile.id)));
                  if (draft?.id === profile.id) setDraft(null);
                }}
              >
                {t("common.delete")}
              </ActionButton>
            </div>
          </li>
        ))}
      </ul>
      {!draft && (
        <ActionButton
          size="sm"
          variant="ghost"
          onClick={() => setDraft({ id: createProfileId(), name: "", folder: "" })}
        >
          {t("processing.addProfile")}
        </ActionButton>
      )}
      {draft && (
        <div className="space-y-3 rounded-md border border-border bg-surface-raised p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("processing.profileName")} value={draft.name} onChange={(name) => edit({ name })} />
            <Field
              label={t("processing.folder")}
              value={draft.folder}
              onChange={(folder) => edit({ folder })}
              placeholder={t("processing.root")}
            />
            <Field
              label={t("settings.transcription.model")}
              value={draft.model ?? ""}
              onChange={(model) => edit({ model: model || undefined })}
              placeholder={t("processing.inherit")}
            />
            <Field
              label={t("settings.transcription.language")}
              value={draft.language ?? ""}
              onChange={(language) => edit({ language: language || undefined })}
              placeholder="en, zh, auto"
            />
            <label className="space-y-1 text-sm text-text">
              <span>{t("settings.transcription.output")}</span>
              <Select
                ariaLabel={t("settings.transcription.output")}
                value={draft.outputFormat ?? ""}
                onChange={(value) => edit({ outputFormat: (value || undefined) as ProcessingProfile["outputFormat"] })}
              >
                <option value="">{t("processing.inherit")}</option>
                {["srt", "vtt", "ass", "txt"].map((ext) => (
                  <option key={ext} value={ext}>
                    {ext.toUpperCase()}
                  </option>
                ))}
              </Select>
            </label>
            <Field
              label={t("settings.transcription.maxSubtitleDuration")}
              type="number"
              value={String(draft.maxCueDuration ?? "")}
              onChange={(value) => edit({ maxCueDuration: value ? Number(value) : undefined })}
            />
            <Field
              label={t("processing.maxWidth")}
              type="number"
              value={String(draft.maxLineWidth ?? "")}
              onChange={(value) => edit({ maxLineWidth: value ? Number(value) : undefined })}
            />
            <Field
              label={t("processing.maxSpeed")}
              type="number"
              value={String(draft.maxReadingSpeed ?? "")}
              onChange={(value) => edit({ maxReadingSpeed: value ? Number(value) : undefined })}
            />
          </div>
          {tasks.length > 0 && (
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-text">
              <legend className="mb-2 font-medium">{t("processing.targets")}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.targetTaskIds === undefined}
                  onChange={(event) => edit({ targetTaskIds: event.target.checked ? undefined : [] })}
                />
                {t("processing.inherit")}
              </label>
              {draft.targetTaskIds !== undefined &&
                tasks.map(({ id, target_lang }) => (
                  <label key={id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.targetTaskIds?.includes(id)}
                      onChange={(event) =>
                        edit({
                          targetTaskIds: event.target.checked
                            ? [...(draft.targetTaskIds ?? []), id]
                            : draft.targetTaskIds?.filter((item) => item !== id),
                        })
                      }
                    />
                    {target_lang}
                  </label>
                ))}
            </fieldset>
          )}
          {correctionLists.length > 0 && (
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-text">
              <legend className="mb-2 font-medium">{t("processing.correctionLists")}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.correctionListIds === undefined}
                  onChange={(event) => edit({ correctionListIds: event.target.checked ? undefined : [] })}
                />
                {t("processing.inherit")}
              </label>
              {draft.correctionListIds !== undefined &&
                correctionLists.map(({ id, name }) => (
                  <label key={id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.correctionListIds?.includes(id)}
                      onChange={(event) =>
                        edit({
                          correctionListIds: event.target.checked
                            ? [...(draft.correctionListIds ?? []), id]
                            : draft.correctionListIds?.filter((item) => item !== id),
                        })
                      }
                    />
                    {name}
                  </label>
                ))}
            </fieldset>
          )}
          <ToggleRow
            title={t("processing.review")}
            description={t("processing.reviewHelp")}
            checked={draft.review === true}
            onChange={(review) => edit({ review })}
          />
          <ToggleRow
            title={t("processing.exportNote")}
            description={t("processing.exportNoteHelp")}
            checked={draft.exportNote === true}
            onChange={(exportNote) => edit({ exportNote })}
          />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {t("processing.invalidProfile")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <ActionButton size="sm" variant="primary" onClick={save}>
              {t("processing.applyProfile")}
            </ActionButton>
            <ActionButton size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </ActionButton>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
