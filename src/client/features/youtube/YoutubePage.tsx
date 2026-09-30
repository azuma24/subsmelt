import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../components/Toast";
import { useSettingsQuery, useTasksQuery, useYoutubePlaylistsQuery, useYoutubeStatusQuery } from "../../hooks";
import { str } from "../../lib/settings-value";
import type { YoutubePlaylist } from "../../types";
import { ActionButton } from "../../ui/primitives";
import { PageError } from "../../ui/QueryState";
import { Banner } from "./parts";
import { FollowPlaylistDialog } from "./FollowPlaylistDialog";
import { PlaylistDetail } from "./PlaylistDetail";
import { PlaylistList } from "./PlaylistList";
import { usePlaylistActions } from "./usePlaylistActions";

type DialogState = { kind: "follow" } | { kind: "edit"; playlist: YoutubePlaylist } | null;

const TOPBAR_CLS = "sticky top-0 z-30 flex h-[50px] shrink-0 items-center gap-2.5 border-b border-[var(--border)] bg-[var(--surface)] px-3.5 md:px-[18px]";

export function YoutubePage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("playlist");
  const playlistsQuery = useYoutubePlaylistsQuery();
  const statusQuery = useYoutubeStatusQuery();
  const settingsQuery = useSettingsQuery();
  const tasksQuery = useTasksQuery();
  const actions = usePlaylistActions();
  const [dialog, setDialog] = useState<DialogState>(null);

  const playlists = playlistsQuery.data?.playlists ?? [];
  const selected = selectedId ? playlists.find((p) => p.id === selectedId) : undefined;
  const mediaDir = str(settingsQuery.data?._media_dir, "/media").replace(/\/+$/, "");
  const folderRoot = `${mediaDir}/${str(settingsQuery.data?.youtube_download_dir, "YouTube")}`;
  const ytdlpMissing = statusQuery.data?.ytdlp.available === false;

  const openPlaylist = (playlist: YoutubePlaylist | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (playlist) next.set("playlist", playlist.id);
      else next.delete("playlist");
      return next;
    });

  const onSaved = (playlistId: string, title: string, created: boolean) => {
    setDialog(null);
    addToast(created ? t("youtube.toast.followed", { title }) : t("youtube.toast.checked", { title, added: 0, removed: 0 }), "success");
    void queryClient.invalidateQueries({ queryKey: ["youtube"] });
    if (created) setParams({ playlist: playlistId });
  };

  const topbar = selectedId ? (
    <div className={TOPBAR_CLS}>
      <h1 className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
        <button type="button" onClick={() => openPlaylist(null)} className="min-h-[44px] shrink-0 text-[var(--text-2)] hover:text-[var(--accent)]">
          {t("youtube.title")}
        </button>
        <span aria-hidden="true" className="text-[var(--text-3)]">/</span>
        <span className="truncate">{selected?.title ?? ""}</span>
      </h1>
      {selected && (
        <>
          <ActionButton variant="ghost" size="sm" onClick={() => void actions.checkNow(selected)} busy={actions.isChecking(selected)}>
            {actions.isChecking(selected) ? t("youtube.checking") : t("youtube.checkNow")}
          </ActionButton>
          <button type="button" onClick={() => setDialog({ kind: "edit", playlist: selected })} className="min-h-[44px] rounded-lg px-3 text-[12px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
            {t("common.edit")}
          </button>
        </>
      )}
    </div>
  ) : (
    <div className={TOPBAR_CLS}>
      <h1 className="flex-1 text-sm font-semibold text-[var(--text)]">{t("youtube.title")}</h1>
      {playlists.length > 0 && (
        <ActionButton size="sm" onClick={() => setDialog({ kind: "follow" })} disabled={ytdlpMissing}>
          <span aria-hidden="true">＋</span> {t("youtube.follow")}
        </ActionButton>
      )}
    </div>
  );

  const body = (() => {
    if (playlistsQuery.isError) return <PageError onRetry={() => void playlistsQuery.refetch()} />;
    if (playlistsQuery.isLoading) return <ListSkeleton />;
    if (selectedId && !selected) {
      return (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-[13px] text-[var(--text-2)]">
          <p>{t("youtube.notFollowed")}</p>
          <button type="button" onClick={() => openPlaylist(null)} className="mt-2 min-h-[44px] px-2 font-medium text-[var(--accent)] hover:underline">
            {t("youtube.back")}
          </button>
        </div>
      );
    }
    if (selected) return <PlaylistDetail playlist={selected} folderRoot={folderRoot} />;
    if (playlists.length === 0) return <EmptyState onFollow={() => setDialog({ kind: "follow" })} disabled={ytdlpMissing} />;
    return <PlaylistList playlists={playlists} folderRoot={folderRoot} actions={actions} onOpen={openPlaylist} onEdit={(p) => setDialog({ kind: "edit", playlist: p })} />;
  })();

  return (
    <div className="flex min-h-full flex-col">
      {topbar}
      <div className={`w-full max-w-[1040px] flex-1 space-y-3.5 p-3.5 md:p-[18px] ${isMobile ? "pb-6" : ""}`}>
        {ytdlpMissing && <Banner tone="bad" title={t("youtube.banner.noYtdlp")}>{t("youtube.banner.noYtdlpHint")}</Banner>}
        {body}
      </div>
      {dialog && (
        <FollowPlaylistDialog
          playlist={dialog.kind === "edit" ? dialog.playlist : undefined}
          tasks={tasksQuery.data ?? []}
          hasApiKey={Boolean(statusQuery.data?.apiKey)}
          folderRoot={folderRoot}
          onClose={() => setDialog(null)}
          onOpenSettings={() => navigate("/settings?section=youtube")}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function EmptyState({ onFollow, disabled }: { onFollow: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  const steps = ["stepDownload", "stepSubtitles", "stepTranslate", "stepNote"] as const;
  return (
    <section className="mx-auto flex max-w-[560px] flex-col items-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-10 text-center md:px-10 md:py-12">
      <div aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-[20px] text-[var(--accent)]">▶</div>
      <h2 className="text-[20px] font-semibold leading-7 text-[var(--text)]">{t("youtube.empty.title")}</h2>
      <p className="text-[14px] leading-6 text-[var(--text-2)]">{t("youtube.empty.body")}</p>
      <ol aria-label={t("youtube.empty.flowLabel")} className="flex flex-wrap items-center justify-center gap-1.5 text-[12px] text-[var(--text-2)]">
        {steps.map((step, i) => (
          <li key={step} className="flex items-center gap-1.5">
            <span className="rounded-full border border-[var(--border)] px-2.5 leading-6">{t(`youtube.empty.${step}`)}</span>
            {i < steps.length - 1 && <span aria-hidden="true" className="text-[var(--text-3)]">→</span>}
          </li>
        ))}
      </ol>
      <ActionButton onClick={onFollow} disabled={disabled}>
        <span aria-hidden="true">＋</span> {t("youtube.empty.action")}
      </ActionButton>
      <p className="text-[12px] leading-5 text-[var(--text-3)]">{t("youtube.empty.tip")}</p>
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="h-4 w-1/3 rounded bg-[var(--surface-3)]" />
          <div className="h-3 w-1/2 rounded bg-[var(--surface-2)]" />
          <div className="flex gap-1.5">
            <div className="h-6 w-20 rounded-full bg-[var(--surface-2)]" />
            <div className="h-6 w-24 rounded-full bg-[var(--surface-2)]" />
          </div>
        </div>
      ))}
    </div>
  );
}
