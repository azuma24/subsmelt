import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../components/Toast";
import { useSettingsQuery, useTasksQuery, useYoutubePipelineQuery, useYoutubePlaylistsQuery, useYoutubeStatusQuery } from "../../hooks";
import { str } from "../../lib/settings-value";
import type { YoutubeCooldown, YoutubePipeline, YoutubePlaylist } from "../../types";
import { ActionButton } from "../../ui/primitives";
import { PageError } from "../../ui/QueryState";
import { Banner } from "./parts";
import { FollowPlaylistDialog } from "./FollowPlaylistDialog";
import type { FollowKind } from "./format";
import { PlaylistDetail } from "./PlaylistDetail";
import { PlaylistList } from "./PlaylistList";
import { usePlaylistActions } from "./usePlaylistActions";

type DialogState = { kind: "follow"; follow: FollowKind } | { kind: "edit"; playlist: YoutubePlaylist } | null;

const TOPBAR_CLS = "sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 md:px-4";

export function YoutubePage({ isMobile }: { isMobile: boolean }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("playlist");
  const playlistsQuery = useYoutubePlaylistsQuery();
  const statusQuery = useYoutubeStatusQuery();
  const pipelineQuery = useYoutubePipelineQuery();
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
    addToast(created ? t("youtube.toast.followed", { title }) : t("youtube.toast.saved"), "success");
    void queryClient.invalidateQueries({ queryKey: ["youtube"] });
    if (created) setParams({ playlist: playlistId });
  };

  const topbar = selectedId ? (
    <div className={TOPBAR_CLS}>
      <h1 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-text">
        <button type="button" onClick={() => openPlaylist(null)} className="min-h-touch shrink-0 text-muted hover:text-accent">
          {t("youtube.title")}
        </button>
        <span aria-hidden="true" className="text-faint">/</span>
        <span className="truncate">{selected?.title ?? ""}</span>
      </h1>
      {selected && (
        <>
          <ActionButton variant="ghost" size="sm" onClick={() => void actions.checkNow(selected)} busy={actions.isChecking(selected)}>
            {actions.isChecking(selected) ? t("youtube.checking") : t("youtube.checkNow")}
          </ActionButton>
          <button type="button" onClick={() => setDialog({ kind: "edit", playlist: selected })} className="min-h-touch rounded-sm px-3 text-xs font-medium text-muted hover:bg-surface-raised hover:text-text">
            {t("common.edit")}
          </button>
        </>
      )}
    </div>
  ) : (
    <div className={TOPBAR_CLS}>
      <h1 className="flex-1 text-sm font-semibold text-text">{t("youtube.title")}</h1>
      {playlists.length > 0 && (
        <>
          <ActionButton variant="ghost" size="sm" onClick={() => setDialog({ kind: "follow", follow: "channel" })} disabled={ytdlpMissing}>
            <span aria-hidden="true">＋</span> {t("youtube.followChannel")}
          </ActionButton>
          <ActionButton size="sm" onClick={() => setDialog({ kind: "follow", follow: "playlist" })} disabled={ytdlpMissing}>
            <span aria-hidden="true">＋</span> {t("youtube.follow")}
          </ActionButton>
        </>
      )}
    </div>
  );

  const body = (() => {
    if (playlistsQuery.isError) return <PageError onRetry={() => void playlistsQuery.refetch()} />;
    if (playlistsQuery.isLoading) return <ListSkeleton />;
    if (selectedId && !selected) {
      return (
        <div className="rounded-md border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
          <p>{t("youtube.notFollowed")}</p>
          <button type="button" onClick={() => openPlaylist(null)} className="mt-2 min-h-touch px-2 font-medium text-accent hover:underline">
            {t("youtube.back")}
          </button>
        </div>
      );
    }
    if (selected) return <PlaylistDetail key={selected.id} playlist={selected} folderRoot={folderRoot} />;
    if (playlists.length === 0) return <EmptyState onFollow={(follow) => setDialog({ kind: "follow", follow })} disabled={ytdlpMissing} />;
    return <PlaylistList playlists={playlists} folderRoot={folderRoot} actions={actions} onOpen={openPlaylist} onEdit={(p) => setDialog({ kind: "edit", playlist: p })} />;
  })();

  return (
    <div className="flex min-h-full flex-col">
      {topbar}
      <div className={`w-full max-w-[1040px] flex-1 space-y-4 p-4 md:p-4 ${isMobile ? "pb-6" : ""}`}>
        {ytdlpMissing && <Banner tone="bad" title={t("youtube.banner.noYtdlp")}>{t("youtube.banner.noYtdlpHint")}</Banner>}
        <CooldownBanner cooldown={statusQuery.data?.cooldown ?? null} onExpired={() => void statusQuery.refetch()} onAddCookies={() => navigate("/settings?section=youtube")} />
        <PipelineBanners pipeline={pipelineQuery.data} onOpenSettings={() => navigate("/settings?section=stt")} />
        {body}
      </div>
      {dialog && (
        <FollowPlaylistDialog
          playlist={dialog.kind === "edit" ? dialog.playlist : undefined}
          kind={dialog.kind === "follow" ? dialog.follow : undefined}
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

/** YouTube pushed back: downloads pause until the cooldown ends. Refetches the status when it does. */
function CooldownBanner({ cooldown, onExpired, onAddCookies }: { cooldown: YoutubeCooldown | null; onExpired: () => void; onAddCookies: () => void }) {
  const { t, i18n } = useTranslation();
  const untilMs = cooldown ? Date.parse(cooldown.until) : 0;
  const active = untilMs > Date.now();
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(onExpired, Math.min(untilMs - Date.now() + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [active, untilMs, onExpired]);
  if (!cooldown || !active) return null;
  const time = new Intl.DateTimeFormat(i18n.language, { hour: "numeric", minute: "2-digit", ...(untilMs - Date.now() > 20 * 3_600_000 ? { weekday: "short" } : {}) }).format(untilMs);
  const bot = cooldown.cause === "bot_check";
  return (
    <Banner
      tone="warn"
      title={t(bot ? "youtube.banner.botCheckTitle" : "youtube.banner.cooldownTitle")}
      action={(
        <button type="button" onClick={onAddCookies} className="-my-3 min-h-touch shrink-0 self-center rounded-sm px-2 text-xs font-medium text-accent hover:underline">
          {t("youtube.banner.addCookies")}
        </button>
      )}
    >
      {t(bot ? "youtube.banner.botCheckBody" : "youtube.banner.cooldownBody", { time })}
    </Banner>
  );
}

/** Why subtitles or translations are not moving: no transcription backend, or a shared GPU batching the work. */
function PipelineBanners({ pipeline, onOpenSettings }: { pipeline: YoutubePipeline | undefined; onOpenSettings: () => void }) {
  const { t } = useTranslation();
  if (!pipeline) return null;
  return (
    <>
      {pipeline.transcription.waiting > 0 && (
        <Banner
          tone="warn"
          title={t("youtube.banner.noBackendTitle")}
          action={(
            <button type="button" onClick={onOpenSettings} className="-my-3 min-h-touch shrink-0 self-center rounded-sm px-2 text-xs font-medium text-accent hover:underline">
              {t("youtube.dialog.openSettings")}
            </button>
          )}
        >
          {t("youtube.banner.noBackendBody")}
        </Banner>
      )}
      {pipeline.gpu.held && (
        <Banner tone="info" glyph="GPU" title={t("youtube.banner.gpuTitle", { n: pipeline.gpu.waitingFor })}>
          {t("youtube.banner.gpuBody")}
        </Banner>
      )}
    </>
  );
}

function EmptyState({ onFollow, disabled }: { onFollow: (kind: FollowKind) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const steps = ["stepDownload", "stepSubtitles", "stepTranslate", "stepNote"] as const;
  return (
    <section className="mx-auto flex max-w-[560px] flex-col items-center gap-4 rounded-md border border-border bg-surface px-6 py-12 text-center md:px-12 md:py-12">
      <div aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-md bg-accent-soft text-lg text-accent">▶</div>
      <h2 className="text-lg font-semibold leading-7 text-text">{t("youtube.empty.title")}</h2>
      <p className="text-sm leading-6 text-muted">{t("youtube.empty.body")}</p>
      <ol aria-label={t("youtube.empty.flowLabel")} className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted">
        {steps.map((step, i) => (
          <li key={step} className="flex items-center gap-2">
            <span className="rounded-full border border-border px-3 leading-6">{t(`youtube.empty.${step}`)}</span>
            {i < steps.length - 1 && <span aria-hidden="true" className="text-faint">→</span>}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap justify-center gap-2">
        <ActionButton onClick={() => onFollow("playlist")} disabled={disabled}>
          <span aria-hidden="true">＋</span> {t("youtube.empty.action")}
        </ActionButton>
        <ActionButton variant="ghost" onClick={() => onFollow("channel")} disabled={disabled}>
          <span aria-hidden="true">＋</span> {t("youtube.empty.actionChannel")}
        </ActionButton>
      </div>
      <p className="text-xs leading-5 text-faint">{t("youtube.empty.tip")}</p>
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3 rounded-md border border-border bg-surface p-4">
          <div className="h-4 w-1/3 rounded-sm bg-surface-highlight" />
          <div className="h-3 w-1/2 rounded-sm bg-surface-raised" />
          <div className="flex gap-2">
            <div className="h-6 w-20 rounded-full bg-surface-raised" />
            <div className="h-6 w-24 rounded-full bg-surface-raised" />
          </div>
        </div>
      ))}
    </div>
  );
}
