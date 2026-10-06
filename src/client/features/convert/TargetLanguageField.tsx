import { useId, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { findLanguage, type LanguageEntry } from "./language-table";
import { suggestLanguages, type LanguageResolution } from "./resolve-language";

interface TargetLanguageFieldProps {
  value: string;
  onChange: (value: string) => void;
  resolution: LanguageResolution;
  recents: string[];
  onPick: (entry: LanguageEntry) => void;
}

const inputCls = "w-full rounded-sm border bg-surface-raised px-3 py-2 text-sm text-text placeholder:text-faint";

/**
 * Free-text target-language input: autocomplete while typing, canonical
 * resolution feedback, an explicit choice for ambiguous input ("Chinese"),
 * "did you mean" suggestions for typos, and recent-target chips.
 */
export function TargetLanguageField({ value, onChange, resolution, recents, onPick }: TargetLanguageFieldProps) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const listboxId = useId();

  const completions = useMemo(
    () => (resolution.status === "resolved" ? [] : suggestLanguages(value)),
    [value, resolution.status],
  );
  const recentEntries = useMemo(
    () => recents.map((code) => findLanguage(code)).filter((l): l is LanguageEntry => Boolean(l)),
    [recents],
  );

  const borderCls =
    resolution.status === "resolved"
      ? "border-success-line focus:border-success"
      : value.trim()
        ? "border-warning-line focus:border-warning"
        : "border-border focus:border-accent";

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted">{t("convert.targetLanguage")}</span>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          // Option buttons preventDefault on mousedown, so the input never
          // loses focus to a pick — blur can close the list immediately.
          onBlur={() => setFocused(false)}
          placeholder={t("convert.targetPlaceholder")}
          aria-label={t("convert.targetLanguage")}
          role="combobox"
          aria-expanded={focused && completions.length > 0}
          aria-controls={listboxId}
          className={`${inputCls} ${borderCls}`}
        />
        {focused && completions.length > 0 && (
          <div
            id={listboxId}
            className="absolute z-40 mt-1 w-full overflow-hidden rounded-sm border border-border bg-surface shadow-2"
            role="listbox"
          >
            {completions.map((entry) => (
              <div key={entry.code} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(entry)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text hover:bg-surface-raised"
                >
                  <span>{entry.englishName}</span>
                  <span className="text-faint">{entry.nativeName}</span>
                  <span className="ml-auto font-mono text-xs text-faint">{entry.code}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {resolution.status === "resolved" && (
        <span className="text-xs text-success">
          {t("convert.targetResolved", { name: resolution.language.englishName, code: resolution.language.code })}
        </span>
      )}

      {resolution.status === "ambiguous" && (
        <div className="rounded-sm border border-warning-line bg-warning-soft px-3 py-2">
          <span className="text-xs text-warning">{t("convert.ambiguousPick", { input: value.trim() })}</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {resolution.options.map((entry) => (
              <button
                key={entry.code}
                type="button"
                onClick={() => onPick(entry)}
                className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-text hover:border-accent-line"
              >
                {entry.englishName} ({entry.code})
              </button>
            ))}
          </div>
        </div>
      )}

      {resolution.status === "unknown" && value.trim() !== "" && resolution.suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-warning">{t("convert.didYouMean")}</span>
          {resolution.suggestions.map((entry) => (
            <button
              key={entry.code}
              type="button"
              onClick={() => onPick(entry)}
              className="rounded-full border border-border bg-surface-raised px-3 py-1 text-xs text-text hover:border-accent-line"
            >
              {entry.englishName} ({entry.code})
            </button>
          ))}
        </div>
      )}

      {recentEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">{t("convert.recentLabel")}</span>
          {recentEntries.map((entry) => (
            <button
              key={entry.code}
              type="button"
              onClick={() => onPick(entry)}
              className="rounded-full bg-surface-raised px-3 py-1 text-xs text-muted hover:text-text"
            >
              {entry.nativeName} · {entry.code}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
