import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { findLanguage, type LanguageEntry } from "./language-table";
import { resolveTargetLanguage, suggestLanguages, type LanguageResolution } from "./resolve-language";

interface TargetLanguageFieldProps {
  value: string;
  onChange: (value: string) => void;
  resolution: LanguageResolution;
  recents: string[];
  onPick: (entry: LanguageEntry) => void;
}

const inputCls =
  "w-full rounded-lg border bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]";

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
      ? "border-[var(--green-border)] focus:border-[var(--green)]"
      : value.trim()
        ? "border-[var(--yellow-border)] focus:border-[var(--yellow)]"
        : "border-[var(--border)] focus:border-[var(--accent)]";

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-[var(--text-2)]">{t("convert.targetLanguage")}</span>
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
          <ul id={listboxId} className="absolute z-40 mt-1 w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg" role="listbox">
            {completions.map((entry) => (
              <li key={entry.code} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(entry)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-[var(--text)] hover:bg-[var(--surface-2)]"
                >
                  <span>{entry.englishName}</span>
                  <span className="text-[var(--text-3)]">{entry.nativeName}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-[var(--text-3)]">{entry.code}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {resolution.status === "resolved" && (
        <span className="text-[11.5px] text-[var(--green)]">
          {t("convert.targetResolved", { name: resolution.language.englishName, code: resolution.language.code })}
        </span>
      )}

      {resolution.status === "ambiguous" && (
        <div className="rounded-lg border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-3 py-2">
          <span className="text-[11.5px] text-[var(--yellow)]">{t("convert.ambiguousPick", { input: value.trim() })}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {resolution.options.map((entry) => (
              <button
                key={entry.code}
                type="button"
                onClick={() => onPick(entry)}
                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11.5px] text-[var(--text)] hover:border-[var(--accent-border)]"
              >
                {entry.englishName} ({entry.code})
              </button>
            ))}
          </div>
        </div>
      )}

      {resolution.status === "unknown" && value.trim() !== "" && resolution.suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-[var(--yellow)]">{t("convert.didYouMean")}</span>
          {resolution.suggestions.map((entry) => (
            <button
              key={entry.code}
              type="button"
              onClick={() => onPick(entry)}
              className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11.5px] text-[var(--text)] hover:border-[var(--accent-border)]"
            >
              {entry.englishName} ({entry.code})
            </button>
          ))}
        </div>
      )}

      {recentEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-[var(--text-3)]">{t("convert.recentLabel")}</span>
          {recentEntries.map((entry) => (
            <button
              key={entry.code}
              type="button"
              onClick={() => onPick(entry)}
              className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--text-2)] hover:text-[var(--text)]"
            >
              {entry.nativeName} · {entry.code}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
