import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useToast } from "../../components/Toast";
import { useTasksQuery, useYoutubePipelineQuery, useYoutubeVideosQuery } from "../../hooks";
import { getErrorMessage } from "../../lib";
import type { YoutubePlaylist, YoutubeVideo, YoutubeVideoAction } from "../../types";
import { ActionButton, RowActionsMenu, StatusBadge, Tabs } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { FORM_CONTROL_CLS } from "../../ui/form-classes";
import { Banner, Tag } from "./parts";
import { availabilityLabel, followKind, formatDuration, keepLabel, profileLabel, relativeFromNow, shortDate } from "./format";
import {
  ALL_GROUPS,
  VIDEO_FILTERS,
  countByFilter,
  filterVideos,
  gpuHold,
  pickableVideos,
  statusCounts,
  subtitleSummary,
  videoActionLabelKey,
  videoActions,
  videoFilterOf,
  videoPipeline,
  videoStatusDescriptor,
  type GpuHold,
  type PipeStep,
  type VideoFilter,
} from "./video-status";

interface RowContext {
  hold: GpuHold;
  /** Each Translations task's language code, to name the routes. */
  langCodes: ReadonlyMap<number, string>;
}

const PAGE_SIZE = 200;

const BAR_SEGMENTS: { filter: VideoFilter; color: string }[] = [
  { filter: "done", color: "var(--green)" },
  { filter: "run", color: "var(--accent)" },
  { filter: "wait", color: "var(--border)" },
  { filter: "bad", color: "var(--red)" },
];

export function PlaylistDetail({ playlist, folderRoot }: { playlist: YoutubePlaylist; folderRoot: string }) {
  const { t, i18n } = useTranslation();
  const videosQuery = useYoutubeVideosQuery(playlist.id);
  const pipelineQuery = useYoutubePipelineQuery();
  const tasksQuery = useTasksQuery();
  const hold = gpuHold(pipelineQuery.data);
  const langCodes = useMemo(() => new Map((tasksQuery.data ?? []).map((task) => [task.id, task.lang_code])), [tasksQuery.data]);
  const context: RowContext = { hold, langCodes };
  const [filter, setFilter] = useState<VideoFilter | "all">("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Videos picked on the Skipped tab to download together; kept while searching, cleared with the tab.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const videos = videosQuery.data?.videos ?? [];
  // Every count includes removed videos, as the list and the server's counts do; Kept is counts.all.
  const counts = countByFilter(videosQuery.data ? statusCounts(videos) : playlist.counts.byStatus);
  const visible = useMemo(() => filterVideos(videos, filter, query), [videos, filter, query]);
  // A group header counts every matching row, not only the page shown.
  const groupCounts = useMemo(() => countByFilter(statusCounts(visible)), [visible]);
  const shown = visible.slice(0, limit);
  const picking = filter === "off";
  const pickable = useMemo(() => pickableVideos(shown), [shown]);
  const togglePick = (videoId: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (!next.delete(videoId)) next.add(videoId);
    return next;
  });
  const availability = availabilityLabel(playlist.sync.availability, t);
  const listed = playlist.sync.count ?? playlist.counts.total;

  const tabs = [
    { key: "all", label: t("youtube.tabs.all"), count: counts.all },
    ...VIDEO_FILTERS.map((f) => ({ key: f, label: t(`youtube.tabs.${f}`), count: counts[f] })),
  ];
  const selectTab = (key: string) => {
    setFilter(key as VideoFilter | "all");
    setLimit(PAGE_SIZE);
    setPicked(new Set());
  };
  const clearFilters = () => {
    setFilter("all");
    setQuery("");
  };

  return (
    <div className="space-y-4">
      {playlist.sync.lastError && (
        <Banner tone="bad" title={t("youtube.toast.checkFailed", { error: playlist.sync.lastError })} />
      )}

      <section className="grid gap-4 rounded-md border border-border bg-surface p-4 md:grid-cols-[1fr_auto]">
        <div className="min-w-0 space-y-2">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-text">
            <span className="mr-1">{playlist.title}</span>
            {followKind(playlist.id) === "channel" && <Tag>{t("youtube.channelTag")}</Tag>}
            {availability && <Tag>{availability}</Tag>}
            <Tag>{profileLabel(playlist.media, t)}</Tag>
            <Tag>{playlist.mode === "auto" ? t("youtube.modeAuto") : t("youtube.modeManual")}</Tag>
          </h2>
          <p className="break-words text-xs leading-5 text-faint">
            {[t("youtube.summary.inPlaylist", { count: listed }), keepLabel(playlist.backfill, t, i18n.language), `${folderRoot}/${playlist.folder}`].join(" · ")}
          </p>
          {counts.all > 0 && (
            <>
              <div className="flex h-2 overflow-hidden rounded-full bg-surface-highlight" aria-hidden="true">
                {BAR_SEGMENTS.map(({ filter: f, color }) => (
                  <span key={f} style={{ width: `${(counts[f] / counts.all) * 100}%`, background: color }} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {BAR_SEGMENTS.filter(({ filter: f }) => counts[f] > 0).map(({ filter: f, color }) => (
                  <span key={f} className="inline-flex items-center gap-2">
                    <i className="inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
                    <b className="font-semibold tabular-nums text-text">{counts[f]}</b> {t(`youtube.tabs.${f}`)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <dl className="flex gap-6 md:flex-col md:gap-3 md:text-right">
          <div>
            <dt className="text-xs text-faint">{t("youtube.summary.kept")}</dt>
            <dd className="text-lg font-semibold tabular-nums text-text">{counts.all}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">{t("youtube.summary.nextCheck")}</dt>
            <dd className="text-lg font-semibold text-text">
              {playlist.sync.lastCheckedAt && playlist.sync.nextCheckAt ? relativeFromNow(playlist.sync.nextCheckAt, i18n.language) : "–"}
            </dd>
          </div>
        </dl>
      </section>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 overflow-x-auto">
          <Tabs tabs={tabs} activeKey={filter} onSelect={selectTab} />
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE_SIZE);
          }}
          placeholder={t("youtube.search")}
          aria-label={t("youtube.search")}
          className={`${FORM_CONTROL_CLS} min-h-touch md:max-w-[280px]`}
        />
      </div>

      {videosQuery.isError ? (
        <InlineError onRetry={() => void videosQuery.refetch()} />
      ) : videosQuery.isLoading ? (
        <VideoSkeleton />
      ) : videos.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-12 text-center text-sm leading-6 text-muted">
          {playlist.sync.checking ? t("youtube.checking") : t("youtube.noVideos")}
        </p>
      ) : visible.length === 0 && filter === "all" && !query && counts.off > 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-12 text-center text-sm leading-6 text-muted">
          <p>{t("youtube.allFiltered")}</p>
          <button type="button" onClick={() => selectTab("off")} className="mt-1 min-h-touch px-2 font-medium text-accent hover:underline">
            {t("youtube.tabs.off")} ({counts.off})
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
          {t("youtube.noMatch")}{" "}
          <button type="button" onClick={clearFilters} className="min-h-touch px-2 font-medium text-accent hover:underline">
            {t("youtube.clearFilters")}
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-surface">
          {filter === "all"
            ? ALL_GROUPS.map((group) => {
              const rows = shown.filter((v) => videoFilterOf(v.status) === group);
              if (rows.length === 0) return null;
              return (
                <section key={group}>
                  <h3 className="flex justify-between border-b border-border bg-surface-raised px-4 py-2 text-xs font-medium text-muted">
                    <span>{t(`youtube.tabs.${group}`)}</span>
                    <span className="tabular-nums">{groupCounts[group]}</span>
                  </h3>
                  <VideoRows videos={rows} context={context} />
                </section>
              );
            })
            : (
              <>
                {picking && pickable.length > 0 && (
                  <PickBar playlistId={playlist.id} pickable={pickable} picked={picked} onChange={setPicked} />
                )}
                <VideoRows videos={shown} context={context} picked={picking ? picked : undefined} onTogglePick={togglePick} />
              </>
            )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-faint">
            <span>{t("youtube.showing", { shown: shown.length, total: visible.length })}</span>
            {shown.length < visible.length && (
              <button type="button" onClick={() => setLimit((n) => n + PAGE_SIZE)} className="min-h-touch px-2 font-medium text-accent hover:underline">
                +{Math.min(PAGE_SIZE, visible.length - shown.length)}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface PickBarProps {
  playlistId: string;
  pickable: YoutubeVideo[];
  picked: ReadonlySet<string>;
  onChange: (picked: ReadonlySet<string>) => void;
}

/** Select the shown skipped videos and send the picked ones to download in one request. */
function PickBar({ playlistId, pickable, picked, onChange }: PickBarProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const allShown = pickable.every((v) => picked.has(v.video_id));
  const toggleAll = () => {
    const next = new Set(picked);
    for (const video of pickable) {
      if (allShown) next.delete(video.video_id);
      else next.add(video.video_id);
    }
    onChange(next);
  };
  const download = async () => {
    setBusy(true);
    try {
      const { downloaded } = await api.downloadYoutubeVideos(playlistId, [...picked]);
      addToast(t("youtube.pick.queued", { count: downloaded }), "success");
      onChange(new Set());
    } catch (error) {
      addToast(t("youtube.actions.failed", { error: getErrorMessage(error) }), "error");
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["youtube"] });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-raised px-4 py-2">
      <label className="flex min-h-touch cursor-pointer items-center gap-3 text-sm text-text">
        <input type="checkbox" checked={allShown} onChange={toggleAll} className="accent-accent" />
        {t("youtube.pick.selectShown", { count: pickable.length })}
      </label>
      <span className="flex-1 text-xs tabular-nums text-muted" aria-live="polite">
        {picked.size > 0 ? t("youtube.pick.selected", { count: picked.size }) : null}
      </span>
      {picked.size > 0 && (
        <button type="button" onClick={() => onChange(new Set())} className="min-h-touch rounded-sm px-3 text-xs font-medium text-muted hover:bg-surface-highlight hover:text-text">
          {t("youtube.pick.clear")}
        </button>
      )}
      <ActionButton size="sm" onClick={() => void download()} disabled={picked.size === 0} busy={busy}>
        {t("youtube.pick.download", { count: picked.size })}
      </ActionButton>
    </div>
  );
}

function VideoRows({ videos, context, picked, onTogglePick }: { videos: YoutubeVideo[]; context: RowContext; picked?: ReadonlySet<string>; onTogglePick?: (videoId: string) => void }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const runAction = async (video: YoutubeVideo, action: YoutubeVideoAction) => {
    try {
      await api.youtubeVideoAction(video.video_id, action);
    } catch (error) {
      addToast(t("youtube.actions.failed", { error: getErrorMessage(error) }), "error");
    }
    void queryClient.invalidateQueries({ queryKey: ["youtube"] });
  };
  return (
    <ul className="divide-y divide-border">
      {videos.map((video) => (
        <VideoRow
          key={video.video_id}
          video={video}
          context={context}
          onAction={(action) => void runAction(video, action)}
          pick={picked && video.status === "skipped" ? { checked: picked.has(video.video_id), onToggle: () => onTogglePick?.(video.video_id) } : undefined}
        />
      ))}
    </ul>
  );
}

const PIPE_STEP_CLS: Record<PipeStep, string> = {
  "": "bg-surface-highlight",
  done: "bg-success",
  now: "bg-surface-highlight",
  wait: "bg-[repeating-linear-gradient(90deg,var(--yellow)_0_4px,transparent_4px_7px)]",
  fail: "bg-danger",
};
const PIPE_STEP_KEYS = ["stepDownload", "stepSubtitles", "stepTranslate", "stepNote"] as const;

/** Four segments for download, subtitles, translate and note; the running one fills with its percentage. */
function Pipeline({ steps, pct }: { steps: readonly PipeStep[]; pct: number | undefined }) {
  const { t } = useTranslation();
  return (
    <span className="flex gap-1" aria-hidden="true">
      {steps.map((step, i) => (
        <span key={PIPE_STEP_KEYS[i]} title={t(`youtube.empty.${PIPE_STEP_KEYS[i]}`)} className={`relative h-1 w-8 overflow-hidden rounded-full ${PIPE_STEP_CLS[step]}`}>
          {step === "now" && <span className="absolute inset-y-0 left-0 bg-accent transition-[width]" style={{ width: `${pct ?? 100}%` }} />}
        </span>
      ))}
    </span>
  );
}

interface VideoRowProps {
  video: YoutubeVideo;
  context: RowContext;
  onAction: (action: YoutubeVideoAction) => void;
  /** Present on the Skipped tab, where rows can be picked for download. */
  pick?: { checked: boolean; onToggle: () => void };
}

function VideoRow({ video, context, onAction, pick }: VideoRowProps) {
  const { t, i18n } = useTranslation();
  const dim = video.status === "skipped" || video.status === "unavailable";
  const title = video.title || t("youtube.privateOrDeleted");
  const note = video.status === "unavailable"
    ? video.title ? t("youtube.privateOrDeleted") : null
    : video.status === "skipped" && video.skip_kind === "content" && video.content_kind
      ? t(`youtube.contentOff.${video.content_kind}`)
      : video.status === "skipped" && video.skip_kind
        ? t(`youtube.skipKind.${video.skip_kind}`)
        : video.reason;
  const retry = video.retry_after && (video.status === "queued" || video.status === "waiting")
    ? t("youtube.retryAt", { time: relativeFromNow(video.retry_after, i18n.language) })
    : null;
  const meta = [video.channel, formatDuration(video.duration_s), video.published_at ? t("youtube.posted", { date: shortDate(video.published_at, i18n.language) }) : null].filter(Boolean);
  const subtitles = video.subtitles ? subtitleSummary({ ...video, subtitles: video.subtitles }, context.langCodes, context.hold, t) : null;
  const url = `https://www.youtube.com/watch?v=${video.video_id}`;
  const menu = [
    ...videoActions(video.status).map((action) => ({ label: t(videoActionLabelKey(video.status, action)), onClick: () => onAction(action) })),
    { label: t("youtube.openOnYoutube"), onClick: () => window.open(url, "_blank", "noopener,noreferrer") },
  ];

  return (
    <li className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[1fr_210px_auto] ${dim ? "opacity-70" : ""}`}>
      <div className="flex min-w-0 gap-3">
        {pick && (
          <label className="-my-3 -ml-3 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={pick.checked}
              onChange={pick.onToggle}
              aria-label={t("youtube.pick.one", { title })}
              className="h-5 w-5 cursor-pointer accent-accent"
            />
          </label>
        )}
        <div className="min-w-0">
          <p className="line-clamp-2 text-sm font-medium leading-5 text-text">{title}</p>
          <p className="mt-1 text-xs leading-5 text-faint">
            <span className="block truncate">
              {meta.join(" · ")}
              {video.removed_at && <> · <span className="text-warning">{t("youtube.removedTag")}</span></>}
            </span>
            {subtitles && <span className="block break-words text-muted">{subtitles}</span>}
            {(note || retry) && (
              <span className={`line-clamp-2 break-words ${video.status === "failed" ? "text-danger" : ""}`}>{[note, retry].filter(Boolean).join(" · ")}</span>
            )}
          </p>
        </div>
      </div>
      <div className="col-start-1 row-start-2 flex flex-col items-start gap-2 md:col-start-auto md:row-start-auto">
        <Pipeline steps={videoPipeline(video, context.hold)} pct={video.pct} />
        <span className="flex items-center gap-2">
          <StatusBadge status={videoStatusDescriptor(video, t, context.hold)} />
          {video.pct !== undefined && <span className="font-mono text-xs tabular-nums text-faint">{video.pct}%</span>}
        </span>
      </div>
      <div className="col-start-2 row-span-2 row-start-1 md:col-start-auto md:row-span-1 md:row-start-auto">
        <RowActionsMenu items={menu} />
      </div>
    </li>
  );
}

function VideoSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
          <div className="flex-1 space-y-2">
            <div className="h-4 w-3/4 rounded-sm bg-surface-highlight" />
            <div className="h-3 w-1/3 rounded-sm bg-surface-raised" />
          </div>
          <div className="h-6 w-24 rounded-full bg-surface-raised" />
        </div>
      ))}
    </div>
  );
}
