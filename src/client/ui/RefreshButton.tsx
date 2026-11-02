import { useTranslation } from "../i18n";
import { ActionButton } from "./primitives";
import { Icon } from "./Icon";

export interface RefreshButtonProps {
  busy: boolean;
  onClick: () => void;
  className?: string;
  /** Icon only on phones; the label stays as the accessible name. */
  labelHiddenBelowMd?: boolean;
}

/**
 * The re-read control shared by the Library and the Transcribe picker:
 * disabled with a spinner while the scan refetch is in flight, otherwise the
 * Refresh ghost button.
 */
export function RefreshButton({ busy, onClick, className = "", labelHiddenBelowMd = false }: RefreshButtonProps) {
  const { t } = useTranslation();
  const labelClass = labelHiddenBelowMd ? "sr-only md:not-sr-only" : undefined;
  return (
    <ActionButton variant="ghost" size="sm" onClick={onClick} disabled={busy} className={className}>
      {busy ? (
        <>
          <span
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent"
            aria-hidden="true"
          />
          <span className={labelClass}>{t("whisper.scanning")}</span>
        </>
      ) : (
        <>
          <Icon name="retry" /> <span className={labelClass}>{t("whisper.refresh")}</span>
        </>
      )}
    </ActionButton>
  );
}
