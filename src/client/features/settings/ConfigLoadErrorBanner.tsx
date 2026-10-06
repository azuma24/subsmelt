import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { getErrorMessage } from "../../lib";
import { useConfirm } from "../../components/ConfirmModal";
import { useToast } from "../../components/Toast";
import { ActionButton } from "../../ui/primitives";
import { Banner } from "../youtube/parts";

export interface ConfigLoadFailure {
  file: string;
  backup: string;
  message: string;
}

/** The server's `_config_load_error`, when config.json could not be parsed. */
export function configLoadFailureOf(settings: Record<string, unknown>): ConfigLoadFailure | null {
  const value = settings._config_load_error;
  if (!value || typeof value !== "object") return null;
  const { file, backup, message } = value as Record<string, unknown>;
  return typeof file === "string" && typeof backup === "string"
    ? { file, backup, message: typeof message === "string" ? message : "" }
    : null;
}

/**
 * config.json exists but did not parse. The server runs on defaults and saves
 * nothing until the user fixes the file or confirms replacing it here.
 */
export function ConfigLoadErrorBanner({ failure }: { failure: ConfigLoadFailure }) {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState(false);

  const replace = async () => {
    const ok = await confirm({
      title: t("settings.configLoadError.confirmTitle"),
      message: t("settings.configLoadError.confirmMessage", { file: failure.file, backup: failure.backup }),
      confirmLabel: t("settings.configLoadError.replace"),
      danger: true,
    });
    if (!ok) return;
    setReplacing(true);
    try {
      await api.replaceBrokenConfig();
      addToast(t("settings.configLoadError.replaced"), "success");
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      addToast(t("settings.saveFailed", { message: getErrorMessage(error) }), "error");
    }
    setReplacing(false);
  };

  return (
    <Banner tone="bad" title={t("settings.configLoadError.title", { file: failure.file })}>
      {t("settings.configLoadError.body", { backup: failure.backup })}
      {failure.message && <span className="mt-1 block break-all font-mono text-xs text-[var(--text-2)]">{failure.message}</span>}
      {/* Below the text rather than beside it, so a long path never squeezes the copy on a phone. */}
      <span className="mt-2 block">
        <ActionButton variant="ghost" size="sm" onClick={replace} busy={replacing}>
          {t("settings.configLoadError.replace")}
        </ActionButton>
      </span>
    </Banner>
  );
}
