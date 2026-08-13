import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton, Drawer } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { labelCls, textareaCls } from "./shared";

interface RawConfigDrawerProps {
  settings: Record<string, unknown>;
  /**
   * Deferred writer. The two JSON blobs are validated by the page before any
   * persist, so they are edited with `update` and committed by an explicit
   * Save — never autosaved.
   */
  update: (key: string, value: unknown) => void;
  /** The page's `handleSave`; resolves false when validation blocked the save. */
  onSave: () => Promise<boolean>;
  dirty: boolean;
  saving: boolean;
}

/**
 * L4 escape hatch: the trigger row plus the drawer that houses the two STT JSON
 * blobs (folder defaults + advanced STT). Owns nothing but its own open state,
 * so the trigger stays one click away from the STT section as before.
 */
export function RawConfigDrawer({ settings, update, onSave, dirty, saving }: RawConfigDrawerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium text-[var(--text)]">{t("settings.rawConfig")}</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-2)]">{t("settings.rawConfigHint")}</p>
        </div>
        <ActionButton variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {t("settings.rawConfigOpen")}
        </ActionButton>
      </div>

      <Drawer open={open} onClose={() => setOpen(false)} title={t("settings.rawConfig")}>
        <div className="space-y-5">
          <div>
            <label className={labelCls}>{t("settings.transcription.folderDefaults")}</label>
            <textarea
              aria-label={t("settings.transcription.folderDefaults")}
              value={str(settings.transcription_folder_defaults, "[]")}
              onChange={(e) => update("transcription_folder_defaults", e.target.value)}
              rows={8}
              placeholder={'[{"path":"/media/anime","language":"ja","model":"small"}]'}
              className={`${textareaCls} font-mono text-xs`}
            />
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-3)]">{t("settings.transcription.folderDefaultsHelp")}</p>
          </div>
          <div>
            <label className={labelCls}>{t("settings.transcription.advancedOptions")}</label>
            <textarea
              aria-label={t("settings.transcription.advancedOptions")}
              value={str(settings.transcription_advanced_stt, "{}")}
              onChange={(e) => update("transcription_advanced_stt", e.target.value)}
              rows={8}
              placeholder={'{"beam_size":5,"word_timestamps":true,"initial_prompt":"Lecture audio"}'}
              className={`${textareaCls} font-mono text-xs`}
            />
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-3)]">{t("settings.transcription.advancedOptionsHelp")}</p>
          </div>
          <div className="flex justify-end gap-2">
            <ActionButton variant="ghost" size="sm" onClick={() => setOpen(false)}>{t("common.close")}</ActionButton>
            <ActionButton size="sm" onClick={async () => { if (await onSave()) setOpen(false); }} disabled={!dirty || saving}>{saving ? t("app.saving") : t("app.save")}</ActionButton>
          </div>
        </div>
      </Drawer>
    </>
  );
}
