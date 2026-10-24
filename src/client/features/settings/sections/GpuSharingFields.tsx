import { useTranslation } from "../../../i18n";
import { str } from "../../../lib/settings-value";
import { ToggleRow } from "./shared";

interface GpuSharingFieldsProps {
  settings: Record<string, unknown>;
  update: (key: string, value: unknown) => void;
}

/**
 * Whether Whisper and the translation model share one GPU, and, only then,
 * whether Convert-page translations take turns with Whisper as well.
 */
export function GpuSharingFields({ settings, update }: GpuSharingFieldsProps) {
  const { t } = useTranslation();
  const shared = str(settings.gpu_shared, "0") === "1";
  return (
    <>
      <ToggleRow
        title={t("settings.transcription.gpuSharedLabel")}
        description={t("settings.transcription.gpuSharedHelp")}
        checked={shared}
        onChange={(checked) => update("gpu_shared", checked ? "1" : "0")}
      />
      {shared && (
        <ToggleRow
          title={t("settings.transcription.convertGpuSharedLabel")}
          description={t("settings.transcription.convertGpuSharedHelp")}
          checked={str(settings.convert_gpu_shared, "0") === "1"}
          onChange={(checked) => update("convert_gpu_shared", checked ? "1" : "0")}
        />
      )}
    </>
  );
}
