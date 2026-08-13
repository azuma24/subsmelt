import { useTranslation } from "react-i18next";
import { Accordion, Field } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { labelCls, selectCls } from "./shared";

interface PathMappingFieldsProps {
  settings: Record<string, unknown>;
  isMobile: boolean;
  /** Deferred writer — every control here is persisted by the topbar Save. */
  update: (key: string, value: unknown) => void;
}

/**
 * Transport + host/container path translation for the Whisper backend.
 * All three controls use the deferred `update` writer, unchanged.
 */
export function PathMappingFields({ settings, isMobile, update }: PathMappingFieldsProps) {
  const { t } = useTranslation();
  return (
    <Accordion title={t("settings.pathMapping")}>
      <div className="space-y-3">
        <div className="md:max-w-[480px]">
          <label className={labelCls}>{t("settings.transcription.transport")}</label>
          <select aria-label={t("settings.transcription.transport")} value={str(settings.transcription_transport, "auto")} onChange={(e) => update("transcription_transport", e.target.value)} className={selectCls}>
            <option value="auto">{t("settings.transcription.transportAuto")}</option>
            <option value="shared">{t("settings.transcription.transportShared")}</option>
            <option value="upload">{t("settings.transcription.transportUpload")}</option>
          </select>
          <p className="mt-1 text-[11px] text-[var(--text-2)]">{t("settings.transcription.transportHelp")}</p>
        </div>
        <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2"} md:max-w-[480px]`}>
          <Field label={t("settings.transcription.pathMapFrom")} value={str(settings.transcription_path_map_from)} onChange={(v) => update("transcription_path_map_from", v)} placeholder="/media" help={t("settings.transcription.pathMapFromHelp")} />
          <Field label={t("settings.transcription.pathMapTo")} value={str(settings.transcription_path_map_to)} onChange={(v) => update("transcription_path_map_to", v)} placeholder="/mnt/media" help={t("settings.transcription.pathMapToHelp")} />
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-[11px] text-[var(--text-2)]">
          {t("settings.transcription.pathMapExample", { source: "/media/anime/Episode 01.mkv", target: "/srv/media/anime/Episode 01.mkv", from: "/media", to: "/srv/media" })}
        </div>
      </div>
    </Accordion>
  );
}
