import { useState } from "react";
import { useTranslation } from "../../../i18n";
import { ActionButton, Drawer, TextArea } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { labelCls } from "./shared";

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
      <div className="flex items-center justify-between gap-3 rounded-sm border border-border bg-surface-raised px-3 py-3">
        <div>
          <p className="text-sm font-medium text-text">{t("settings.rawConfig")}</p>
          <p className="mt-1 text-xs text-muted">{t("settings.rawConfigHint")}</p>
        </div>
        <ActionButton variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {t("settings.rawConfigOpen")}
        </ActionButton>
      </div>

      <Drawer open={open} onClose={() => setOpen(false)} title={t("settings.rawConfig")}>
        <div className="space-y-6">
          <div>
            <label className={labelCls}>{t("settings.transcription.folderDefaults")}</label>
            <TextArea
              ariaLabel={t("settings.transcription.folderDefaults")}
              value={str(settings.transcription_folder_defaults, "[]")}
              onChange={(value) => update("transcription_folder_defaults", value)}
              rows={8}
              placeholder={'[{"path":"/media/anime","language":"ja","model":"small"}]'}
              className="text-xs"
              mono
            />
            <p className="mt-1 text-xs leading-relaxed text-faint">{t("settings.transcription.folderDefaultsHelp")}</p>
          </div>
          <div>
            <label className={labelCls}>{t("settings.transcription.advancedOptions")}</label>
            <TextArea
              ariaLabel={t("settings.transcription.advancedOptions")}
              value={str(settings.transcription_advanced_stt, "{}")}
              onChange={(value) => update("transcription_advanced_stt", value)}
              rows={8}
              placeholder={'{"beam_size":5,"word_timestamps":true,"initial_prompt":"Lecture audio"}'}
              className="text-xs"
              mono
            />
            <p className="mt-1 text-xs leading-relaxed text-faint">{t("settings.transcription.advancedOptionsHelp")}</p>
          </div>
          <div className="flex justify-end gap-2">
            <ActionButton variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("common.close")}
            </ActionButton>
            <ActionButton
              size="sm"
              onClick={async () => {
                if (await onSave()) setOpen(false);
              }}
              disabled={!dirty || saving}
            >
              {saving ? t("app.saving") : t("app.save")}
            </ActionButton>
          </div>
        </div>
      </Drawer>
    </>
  );
}
