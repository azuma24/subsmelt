import { useState } from "react";
import { useTranslation } from "react-i18next";
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
          <p className="text-[10.5px] text-[var(--text-3)]">{t("settings.sources.scanProfilesHint")}</p>
          <div className="flex min-w-0 gap-2">
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder={t("settings.sources.profileNamePlaceholder")}
              aria-label={t("settings.sources.profileNamePlaceholder")}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => { onSave(profileName); setProfileName(""); }}
              className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)]"
            >
              {t("settings.sources.saveScanProfile")}
            </button>
          </div>
        </div>
        {profiles.length === 0 ? (
          <p className="text-[10.5px] text-[var(--text-3)]">{t("settings.sources.noScanProfiles")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {profiles.map((profile) => (
              <div key={profile.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-[5px]">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-[var(--text)]">{profile.name}</div>
                  <div className="text-[10px] text-[var(--text-3)]">{t(`settings.sources.profileMode.${profile.scanMode}`)}</div>
                </div>
                <button type="button" onClick={() => onLoad(profile)} className="rounded-md border border-[var(--border)] bg-[var(--surface-3)] px-2 py-1 text-[10px] text-[var(--text-2)] hover:text-[var(--text)]">
                  {t("settings.sources.loadScanProfile")}
                </button>
                <button type="button" onClick={() => onDelete(profile.id)} className="rounded-md px-2 py-1 text-[10px] text-[var(--text-3)] hover:text-[var(--red)]">
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
