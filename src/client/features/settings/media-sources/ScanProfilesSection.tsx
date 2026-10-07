import { useState } from "react";
import { useTranslation } from "../../../i18n";
import { Accordion } from "../../../ui/primitives";
import type { ScanProfile } from "./model";

/**
 * Saved scan scopes. Collapsed by default — profiles are a power-user shortcut
 * and used to sit above the folder tree, pushing the primary control below the
 * fold. Loading a saved profile is open-then-click.
 */
export function ScanProfilesSection({
  profiles,
  onSave,
  onLoad,
  onDelete,
}: {
  profiles: ScanProfile[];
  onSave: (name: string) => void;
  onLoad: (profile: ScanProfile) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [profileName, setProfileName] = useState("");

  return (
    <Accordion title={t("settings.sources.scanProfiles")} defaultOpen={profiles.length > 0}>
      <div className="space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <p className="text-xs text-faint">{t("settings.sources.scanProfilesHint")}</p>
          <div className="flex min-w-0 gap-2">
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder={t("settings.sources.profileNamePlaceholder")}
              aria-label={t("settings.sources.profileNamePlaceholder")}
              className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-3 py-2 text-xs text-text focus:border-accent min-h-touch md:min-h-0"
            />
            <button
              type="button"
              onClick={() => {
                onSave(profileName);
                setProfileName("");
              }}
              className="shrink-0 rounded-sm bg-accent px-3 py-2 text-xs font-medium text-accent-text min-h-touch md:min-h-0"
            >
              {t("settings.sources.saveScanProfile")}
            </button>
          </div>
        </div>
        {profiles.length === 0 ? (
          <p className="text-xs text-faint">{t("settings.sources.noScanProfiles")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center gap-2 rounded-sm border border-border bg-surface-raised px-2 py-1"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-text">{profile.name}</div>
                  <div className="text-xs text-faint">{t(`settings.sources.profileMode.${profile.scanMode}`)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onLoad(profile)}
                  className="rounded-sm border border-border bg-surface-highlight px-2 py-1 text-xs text-muted hover:text-text"
                >
                  {t("settings.sources.loadScanProfile")}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(profile.id)}
                  className="rounded-sm px-2 py-1 text-xs text-faint hover:text-danger"
                >
                  {t("common.delete")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Accordion>
  );
}
