import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton } from "../../../ui/primitives";
import { LANGUAGES } from "../../../app/constants";
import { getThemePref, setThemePref, THEME_PREFS, type ThemePref } from "../../../lib/theme";
import { getFontScale, setFontScale, DEFAULT_SCALE, MIN_SCALE, MAX_SCALE, SCALE_STEP } from "../../../lib/font-scale";
import { labelCls, selectCls } from "./shared";

/**
 * Interface preferences. Nothing here touches the server settings blob — theme
 * and font scale are device-local and the language switch is i18next state —
 * so this section owns its own state and never marks the page dirty.
 */
export function InterfaceSection() {
  const { t, i18n } = useTranslation();
  const [themePref, setThemePrefState] = useState<ThemePref>(getThemePref());
  const [fontScale, setFontScaleState] = useState<number>(getFontScale());
  const currentLanguage = LANGUAGES.find((lang) => i18n.language === lang.code || i18n.language.startsWith(`${lang.code}-`))?.code || "en";

  return (
    <div className="space-y-4">
      <div className="md:max-w-[240px]">
        <label className={labelCls}>{t("settings.interface.theme")}</label>
        <select
          aria-label={t("settings.interface.theme")}
          value={themePref}
          onChange={(e) => {
            const next = e.target.value as ThemePref;
            setThemePrefState(next);
            setThemePref(next);
          }}
          className={selectCls}
        >
          {THEME_PREFS.map((pref) => (
            <option key={pref} value={pref}>{t(`settings.interface.theme_${pref}`)}</option>
          ))}
        </select>
        <p className="mt-1 text-[11.5px] text-[var(--text-3)]">{t("settings.interface.themeHint")}</p>
      </div>
      <div className="md:max-w-[240px]">
        <label className={labelCls}>{t("settings.interface.fontSize")}</label>
        <div className="flex items-center gap-2">
          {/* The glyphs are decorative; the sr-only text is the accessible name. */}
          <ActionButton
            variant="ghost"
            size="sm"
            disabled={fontScale <= MIN_SCALE}
            onClick={() => setFontScaleState(setFontScale(fontScale - SCALE_STEP))}
          >
            <span aria-hidden="true">A−</span>
            <span className="sr-only">{t("settings.interface.fontSizeDecrease")}</span>
          </ActionButton>
          <span className="min-w-[3.25rem] text-center font-mono text-[12px] text-[var(--text-2)]">{fontScale}%</span>
          <ActionButton
            variant="ghost"
            size="sm"
            disabled={fontScale >= MAX_SCALE}
            onClick={() => setFontScaleState(setFontScale(fontScale + SCALE_STEP))}
          >
            <span aria-hidden="true">A+</span>
            <span className="sr-only">{t("settings.interface.fontSizeIncrease")}</span>
          </ActionButton>
          <ActionButton
            variant="ghost"
            size="sm"
            disabled={fontScale === DEFAULT_SCALE}
            onClick={() => setFontScaleState(setFontScale(DEFAULT_SCALE))}
          >
            {t("settings.interface.fontSizeReset")}
          </ActionButton>
        </div>
        <p className="mt-1 text-[11.5px] text-[var(--text-3)]">{t("settings.interface.fontSizeHint")}</p>
      </div>
      <div className="md:max-w-[240px]">
        <label className={labelCls}>{t("settings.interface.language")}</label>
        <select
          aria-label={t("settings.interface.language")}
          value={currentLanguage}
          onChange={(e) => i18n.changeLanguage(e.target.value)}
          className={selectCls}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>{lang.label}</option>
          ))}
        </select>
        <p className="mt-1 text-[11.5px] text-[var(--text-3)]">{t("settings.interface.languageHint")}</p>
      </div>
    </div>
  );
}
