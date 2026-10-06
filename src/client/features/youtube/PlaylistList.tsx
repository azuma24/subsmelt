import { useTranslation } from "react-i18next";
import type { YoutubePlaylist } from "../../types";
import { ActionButton, RowActionsMenu } from "../../ui/primitives";
import { CountChip, Tag } from "./parts";
import { availabilityLabel, followKind, profileLabel, relativeFromNow } from "./format";
import { countByFilter } from "./video-status";
import type { usePlaylistActions } from "./usePlaylistActions";

interface PlaylistListProps {
  playlists: YoutubePlaylist[];
  folderRoot: string;
  actions: ReturnType<typeof usePlaylistActions>;
  onOpen: (playlist: YoutubePlaylist) => void;
  onEdit: (playlist: YoutubePlaylist) => void;
}

export function PlaylistList({ playlists, folderRoot, actions, onOpen, onEdit }: PlaylistListProps) {
  return (
    <ul className="space-y-3">
      {playlists.map((playlist) => (
        <PlaylistRow key={playlist.id} playlist={playlist} folderRoot={folderRoot} actions={actions} onOpen={onOpen} onEdit={onEdit} />
      ))}
    </ul>
  );
}

function PlaylistRow({ playlist, folderRoot, actions, onOpen, onEdit }: { playlist: YoutubePlaylist } & Omit<PlaylistListProps, "playlists">) {
  const { t, i18n } = useTranslation();
  const counts = countByFilter(playlist.counts.byStatus);
  const availability = availabilityLabel(playlist.sync.availability, t);
  const checking = actions.isChecking(playlist);
  const meta = [
    `${folderRoot}/${playlist.folder}`,
    playlist.sync.lastCheckedAt ? t("youtube.checkedAgo", { time: relativeFromNow(playlist.sync.lastCheckedAt, i18n.language) }) : t("youtube.notChecked"),
    playlist.sync.lastCheckedAt && playlist.sync.nextCheckAt ? t("youtube.nextCheckIn", { time: relativeFromNow(playlist.sync.nextCheckAt, i18n.language) }) : null,
  ].filter(Boolean);

  return (
    <li className="flex flex-col gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 md:flex-row md:items-start md:justify-between md:p-4">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onOpen(playlist)}
            className="min-h-touch text-left text-base font-semibold text-[var(--text)] underline-offset-4 hover:text-[var(--accent)] hover:underline"
          >
            {playlist.title}
          </button>
          {followKind(playlist.id) === "channel" && <Tag>{t("youtube.channelTag")}</Tag>}
          {availability && <Tag>{availability}</Tag>}
          <Tag>{profileLabel(playlist.media, t)}</Tag>
          <Tag>{playlist.mode === "auto" ? t("youtube.modeAuto") : t("youtube.modeManual")}</Tag>
        </div>
        <p className="break-words text-xs leading-5 text-[var(--text-3)]">{meta.join(" · ")}</p>
        {playlist.sync.lastError && (
          <p className="break-words text-xs leading-5 text-[var(--red)]">
            <span aria-hidden="true">✕ </span>
            {t("youtube.toast.checkFailed", { error: playlist.sync.lastError })}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
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
