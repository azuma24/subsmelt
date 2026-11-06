import { useState } from "react";
import {
  parseSubtitleIntakeRules,
  SUBTITLE_INTAKE_FALLBACKS,
  type SubtitleIntakeFallback,
  type SubtitleIntakeRule,
} from "../../../../shared/subtitle-intake";
import { LANGUAGE_OPTIONS } from "../../tasks/translation-defaults";
import { useTranslation } from "../../../i18n";
import { Accordion, ActionButton, Select } from "../../../ui/primitives";

export function SubtitleIntakeSection({
  folders,
  rawRules,
  onChange,
}: {
  folders: string[];
  rawRules: string;
  onChange: (rules: string) => void;
}) {
  const { t } = useTranslation();
  const rules = parseSubtitleIntakeRules(rawRules);
  const [editing, setEditing] = useState<string | null>(null);
  const available = [...folders, ""].filter(
    (folder) => !rules.some((rule) => rule.path === folder && folder !== editing),
  );
  if (editing !== null && !available.includes(editing)) available.unshift(editing);
  const [folder, setFolder] = useState<string | null>(null);
  const [language, setLanguage] = useState("eng");
  const [fallback, setFallback] = useState<SubtitleIntakeFallback>("off");
  const nextFolder = folder !== null && available.includes(folder) ? folder : available[0];
  const save = (next: SubtitleIntakeRule[]) => onChange(JSON.stringify(next));
  const reset = () => {
    setEditing(null);
    setFolder(null);
    setLanguage("eng");
    setFallback("off");
  };
  const saveDraft = () => {
    if (nextFolder === undefined) return;
    save([...rules.filter((rule) => rule.path !== editing), { path: nextFolder, language, fallback }]);
    reset();
  };
  const edit = (rule: SubtitleIntakeRule) => {
    setEditing(rule.path);
    setFolder(rule.path);
    setLanguage(rule.language);
    setFallback(rule.fallback);
  };
  const folderName = (value: string) => value || t("settings.sources.dirRules.allFolders");
  const languageName = (value: string) => LANGUAGE_OPTIONS.find((entry) => entry.value === value)?.label ?? value;
  const prefix = "settings.sources.subtitleIntake";

  return (
    <Accordion title={t(`${prefix}.title`)} defaultOpen={rules.length > 0}>
      <div className="space-y-3">
        <p className="text-xs text-muted">{t(`${prefix}.hint`)}</p>
        {rules.length > 0 && (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {rules.map((rule) => (
              <li key={rule.path} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0 text-sm">
                  <bdi className="block break-words font-medium text-text">{folderName(rule.path)}</bdi>
                  <p className="text-xs text-muted">
                    {languageName(rule.language)} · {t(`${prefix}.${rule.fallback}`)}
                  </p>
                </div>
                <div className="flex gap-1">
                  <ActionButton variant="ghost" size="sm" onClick={() => edit(rule)}>
                    {t("common.edit")}
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (editing === rule.path) reset();
                      save(rules.filter((entry) => entry.path !== rule.path));
                    }}
                  >
                    {t("common.delete")}
                  </ActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextFolder !== undefined && (
          <>
            <div className="grid gap-2 md:grid-cols-3">
              <label className="space-y-1 text-xs text-muted">
                <span>{t(`${prefix}.folder`)}</span>
                <Select value={nextFolder} onChange={setFolder} className="min-h-touch">
                  {available.map((path) => (
                    <option key={path} value={path}>
                      {folderName(path)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span>{t(`${prefix}.language`)}</span>
                <Select value={language} onChange={setLanguage} className="min-h-touch">
                  {!LANGUAGE_OPTIONS.some((option) => option.value === language) && (
                    <option value={language}>{language}</option>
                  )}
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span>{t(`${prefix}.fallback`)}</span>
                <Select
                  value={fallback}
                  onChange={(value) => setFallback(value as SubtitleIntakeFallback)}
                  className="min-h-touch"
                >
                  {SUBTITLE_INTAKE_FALLBACKS.map((value) => (
                    <option key={value} value={value}>
                      {t(`${prefix}.${value}`)}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionButton variant="ghost" size="sm" onClick={saveDraft}>
                {t(editing === null ? `${prefix}.add` : "common.save")}
              </ActionButton>
              {editing !== null && (
                <ActionButton variant="ghost" size="sm" onClick={reset}>
                  {t("common.cancel")}
                </ActionButton>
              )}
            </div>
          </>
        )}
      </div>
    </Accordion>
  );
}
