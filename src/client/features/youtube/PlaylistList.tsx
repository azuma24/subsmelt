import { useState } from "react";
import { FORM_CONTROL_CLS } from "../../ui/form-classes";
import { useTranslation } from "../../i18n";
import type { YoutubePlaylist } from "../../types";
import { ActionButton, RowActionsMenu } from "../../ui/primitives";
import { CountChip, Tag } from "./parts";
import { availabilityLabel, followKind, profileLabel, relativeFromNow } from "./format";
import { countByFilter } from "./video-status";
import type { usePlaylistActions } from "./usePlaylistActions";
import { Icon } from "../../ui/Icon";

interface PlaylistListProps {
  playlists: YoutubePlaylist[];
  folderRoot: string;
  noteCounts?: Record<string, { saved: number; blocked: number }> | undefined;
  actions: ReturnType<typeof usePlaylistActions>;
  onOpen: (playlist: YoutubePlaylist) => void;
  onEdit: (playlist: YoutubePlaylist) => void;
}

export function PlaylistList({ playlists, folderRoot, noteCounts, actions, onOpen, onEdit }: PlaylistListProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const visible = playlists.filter(
    (p) =>
      (!selectedOnly || p.secondBrainExport) &&
      `${p.title} ${p.folder}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("youtube.notes.searchPlaylists")}
          aria-label={t("youtube.notes.searchPlaylists")}
          className={`${FORM_CONTROL_CLS} min-h-touch min-w-[180px] flex-1`}
        />
        <button
          type="button"
          aria-pressed={selectedOnly}
          onClick={() => setSelectedOnly((v) => !v)}
          className={`min-h-touch rounded-sm border px-3 text-xs ${selectedOnly ? "border-accent text-accent" : "border-border text-muted"}`}
        >
          {t("youtube.notes.selectedOnly")}
        </button>
      </div>
      {visible.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted">
          {t("youtube.noMatch")}
        </p>
      )}
      <ul className="space-y-3">
        {visible.map((playlist) => (
          <PlaylistRow
            key={playlist.id}
            playlist={playlist}
            folderRoot={folderRoot}
            noteCounts={noteCounts}
            actions={actions}
            onOpen={onOpen}
            onEdit={onEdit}
          />
        ))}
      </ul>
    </div>
  );
}

function PlaylistRow({
  playlist,
  folderRoot,
  noteCounts,
  actions,
  onOpen,
  onEdit,
}: { playlist: YoutubePlaylist } & Omit<PlaylistListProps, "playlists">) {
  const { t, i18n } = useTranslation();
  const counts = countByFilter(playlist.counts.byStatus);
  const notes = noteCounts?.[playlist.id];
  const availability = availabilityLabel(playlist.sync.availability, t);
  const checking = actions.isChecking(playlist);
  const meta = [
    `${folderRoot}/${playlist.folder}`,
    playlist.sync.lastCheckedAt
      ? t("youtube.checkedAgo", { time: relativeFromNow(playlist.sync.lastCheckedAt, i18n.language) })
      : t("youtube.notChecked"),
    playlist.sync.lastCheckedAt && playlist.sync.nextCheckAt
      ? t("youtube.nextCheckIn", { time: relativeFromNow(playlist.sync.nextCheckAt, i18n.language) })
      : null,
  ].filter(Boolean);

  return (
    <li className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 md:flex-row md:items-start md:justify-between md:p-4">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onOpen(playlist)}
            className="min-h-touch text-left text-base font-semibold text-text underline-offset-4 hover:text-accent hover:underline"
          >
            {playlist.title}
          </button>
          {followKind(playlist.id) === "channel" && <Tag>{t("youtube.channelTag")}</Tag>}
          {availability && <Tag>{availability}</Tag>}
          <Tag>{profileLabel(playlist.media, t)}</Tag>
          <Tag>{playlist.mode === "auto" ? t("youtube.modeAuto") : t("youtube.modeManual")}</Tag>
          {playlist.secondBrainExport && <Tag>{t("youtube.notes.selectedOnly")}</Tag>}
        </div>
        <p className="break-words text-xs leading-5 text-faint">{meta.join(" · ")}</p>
        {playlist.sync.lastError && (
          <p className="break-words text-xs leading-5 text-danger">
            <Icon name="error" />
            {t("youtube.toast.checkFailed", { error: playlist.sync.lastError })}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {notes && notes.blocked > 0 && <CountChip n={notes.blocked} label={t("youtube.notes.blocked")} tone="bad" />}
          {notes && notes.saved > 0 && <CountChip n={notes.saved} label={t("youtube.notes.saved")} tone="ok" />}
          {counts.done > 0 && <CountChip n={counts.done} label={t("youtube.tabs.done")} tone="ok" />}
          {counts.run > 0 && <CountChip n={counts.run} label={t("youtube.tabs.run")} tone="run" />}
          {counts.wait > 0 && <CountChip n={counts.wait} label={t("youtube.tabs.wait")} />}
          {counts.bad > 0 && <CountChip n={counts.bad} label={t("youtube.tabs.bad")} tone="bad" />}
          {counts.off > 0 && <CountChip n={counts.off} label={t("youtube.tabs.off")} />}
          {playlist.counts.removed > 0 && <CountChip n={playlist.counts.removed} label={t("youtube.removedCount")} />}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ActionButton variant="ghost" size="sm" onClick={() => void actions.checkNow(playlist)} busy={checking}>
          {checking ? t("youtube.checking") : t("youtube.checkNow")}
        </ActionButton>
        <RowActionsMenu
          items={[
            { label: t("common.edit"), onClick: () => onEdit(playlist) },
            { label: t("youtube.unfollow"), onClick: () => void actions.unfollow(playlist), danger: true },
          ]}
        />
      </div>
    </li>
  );
}
