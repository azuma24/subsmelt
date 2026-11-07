import { useState } from "react";
import { useTranslation } from "../../../i18n";
import { ActionButton, Select } from "../../../ui/primitives";
import { LANGUAGES } from "../../../app/constants";
import { getThemePref, setThemePref, THEME_PREFS, type ThemePref } from "../../../lib/theme";
import { getFontScale, setFontScale, DEFAULT_SCALE, MIN_SCALE, MAX_SCALE, SCALE_STEP } from "../../../lib/font-scale";
import { ToggleRow, labelCls } from "./shared";

/** Theme, font size and language are device-local. Subtitle warnings are saved with the app settings. */
export function InterfaceSection({
  subtitleWarnings,
  onSubtitleWarningsChange,
}: {
  subtitleWarnings: boolean;
  onSubtitleWarningsChange: (checked: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [themePref, setThemePrefState] = useState<ThemePref>(getThemePref());
  const [fontScale, setFontScaleState] = useState<number>(getFontScale());
  const currentLanguage =
    LANGUAGES.find((lang) => i18n.language === lang.code || i18n.language.startsWith(`${lang.code}-`))?.code || "en";

  return (
    <div className="space-y-4">
      <div className="md:max-w-[240px]">
        <label className={labelCls}>{t("settings.interface.theme")}</label>
        <Select
          ariaLabel={t("settings.interface.theme")}
          value={themePref}
          onChange={(value) => {
            const next = value as ThemePref;
            setThemePrefState(next);
            setThemePref(next);
          }}
        >
          {THEME_PREFS.map((pref) => (
            <option key={pref} value={pref}>
              {t(`settings.interface.theme_${pref}`)}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-faint">{t("settings.interface.themeHint")}</p>
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
          <span className="min-w-[3.25rem] text-center font-mono text-xs text-muted">{fontScale}%</span>
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
        <p className="mt-1 text-xs text-faint">{t("settings.interface.fontSizeHint")}</p>
      </div>
      <div className="md:max-w-[240px]">
        <label className={labelCls}>{t("settings.interface.language")}</label>
        <Select
          ariaLabel={t("settings.interface.language")}
          value={currentLanguage}
          onChange={(value) => i18n.changeLanguage(value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-faint">{t("settings.interface.languageHint")}</p>
      </div>
      <ToggleRow
        title={t("settings.interface.subtitleWarnings")}
        description={t("settings.interface.subtitleWarningsHint")}
        checked={subtitleWarnings}
        onChange={onSubtitleWarningsChange}
      />
    </div>
  );
}
