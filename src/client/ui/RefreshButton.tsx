import { useTranslation } from "react-i18next";
import { ActionButton } from "./primitives";
import { Icon } from "./Icon";

export interface RefreshButtonProps {
  busy: boolean;
  onClick: () => void;
  className?: string;
}

/**
 * The re-read control shared by the Library and the Transcribe picker:
 * disabled with a spinner while the scan refetch is in flight, otherwise the
 * Refresh ghost button.
 */
export function RefreshButton({ busy, onClick, className = "" }: RefreshButtonProps) {
  const { t } = useTranslation();
  return (
    <ActionButton variant="ghost" size="sm" onClick={onClick} disabled={busy} className={className}>
      {busy ? (
        <>
          <span
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent"
            aria-hidden="true"
          />
          {t("whisper.scanning")}
        </>
      ) : (
        <>
          <Icon name="retry" /> {t("whisper.refresh")}
        </>
      )}
    </ActionButton>
  );
}
