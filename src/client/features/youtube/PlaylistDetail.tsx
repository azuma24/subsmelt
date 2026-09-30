import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useYoutubeVideosQuery } from "../../hooks";
import type { YoutubePlaylist, YoutubeVideo } from "../../types";
import { RowActionsMenu, StatusBadge, Tabs } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";
import { FORM_CONTROL_CLS } from "../../ui/form-classes";
import { Banner, Tag } from "./parts";
import { availabilityLabel, formatDuration, keepLabel, profileLabel, relativeFromNow, shortDate } from "./format";
import { VIDEO_FILTERS, countByFilter, filterVideos, videoFilterOf, videoStatusDescriptor, type VideoFilter } from "./video-status";

const PAGE_SIZE = 200;
// The All tab groups rows in this order: what is moving, what needs a look, what waits, what is finished.
const ALL_GROUPS: VideoFilter[] = ["run", "bad", "wait", "done"];

const BAR_SEGMENTS: { filter: VideoFilter; color: string }[] = [
  { filter: "done", color: "var(--green)" },
  { filter: "run", color: "var(--accent)" },
  { filter: "wait", color: "var(--border)" },
  { filter: "bad", color: "var(--red)" },
];

export function PlaylistDetail({ playlist, folderRoot }: { playlist: YoutubePlaylist; folderRoot: string }) {
  const { t, i18n } = useTranslation();
  const videosQuery = useYoutubeVideosQuery(playlist.id);
  const [filter, setFilter] = useState<VideoFilter | "all">("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const counts = countByFilter(playlist.counts.byStatus);
  const videos = videosQuery.data?.videos ?? [];
  const visible = useMemo(() => filterVideos(videos, filter, query), [videos, filter, query]);
  const shown = visible.slice(0, limit);
  const availability = availabilityLabel(playlist.sync.availability, t);
  const listed = playlist.sync.count ?? playlist.counts.total;

  const tabs = [
    { key: "all", label: t("youtube.tabs.all"), count: counts.all },
    ...VIDEO_FILTERS.map((f) => ({ key: f, label: t(`youtube.tabs.${f}`), count: counts[f] })),
  ];
  const selectTab = (key: string) => {
    setFilter(key as VideoFilter | "all");
    setLimit(PAGE_SIZE);
  };
  const clearFilters = () => {
    setFilter("all");
    setQuery("");
  };

  return (
    <div className="space-y-3.5">
      {playlist.sync.lastError && (
        <Banner tone="bad" title={t("youtube.toast.checkFailed", { error: playlist.sync.lastError })} />
      )}

      <section className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 md:grid-cols-[1fr_auto]">
        <div className="min-w-0 space-y-2">
          <h2 className="flex flex-wrap items-center gap-1.5 text-[20px] font-semibold text-[var(--text)]">
            <span className="mr-1">{playlist.title}</span>
            {availability && <Tag>{availability}</Tag>}
            <Tag>{profileLabel(playlist.media, t)}</Tag>
            <Tag>{playlist.mode === "auto" ? t("youtube.modeAuto") : t("youtube.modeManual")}</Tag>
          </h2>
          <p className="break-words text-[12px] leading-5 text-[var(--text-3)]">
            {[t("youtube.summary.inPlaylist", { count: listed }), keepLabel(playlist.backfill, t, i18n.language), `${folderRoot}/${playlist.folder}`].join(" · ")}
          </p>
          {counts.all > 0 && (
            <>
              <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
                {BAR_SEGMENTS.map(({ filter: f, color }) => (
                  <span key={f} style={{ width: `${(counts[f] / counts.all) * 100}%`, background: color }} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--text-2)]">
                {BAR_SEGMENTS.filter(({ filter: f }) => counts[f] > 0).map(({ filter: f, color }) => (
                  <span key={f} className="inline-flex items-center gap-1.5">
                    <i className="inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
                    <b className="font-semibold tabular-nums text-[var(--text)]">{counts[f]}</b> {t(`youtube.tabs.${f}`)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <dl className="flex gap-6 md:flex-col md:gap-3 md:text-right">
          <div>
            <dt className="text-[12px] text-[var(--text-3)]">{t("youtube.summary.kept")}</dt>
            <dd className="text-[20px] font-semibold tabular-nums text-[var(--text)]">{counts.all}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-[var(--text-3)]">{t("youtube.summary.nextCheck")}</dt>
            <dd className="text-[20px] font-semibold text-[var(--text)]">
              {playlist.sync.lastCheckedAt && playlist.sync.nextCheckAt ? relativeFromNow(playlist.sync.nextCheckAt, i18n.language) : "–"}
            </dd>
          </div>
        </dl>
      </section>

      <div className="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between">
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
          className={`${FORM_CONTROL_CLS} min-h-[44px] md:max-w-[280px]`}
        />
      </div>

      {videosQuery.isError ? (
        <InlineError onRetry={() => void videosQuery.refetch()} />
      ) : videosQuery.isLoading ? (
        <VideoSkeleton />
      ) : videos.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-[13px] leading-6 text-[var(--text-2)]">
          {playlist.sync.checking ? t("youtube.checking") : t("youtube.noVideos")}
        </p>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-[13px] text-[var(--text-2)]">
          {t("youtube.noMatch")}{" "}
          <button type="button" onClick={clearFilters} className="min-h-[44px] px-2 font-medium text-[var(--accent)] hover:underline">
            {t("youtube.clearFilters")}
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {filter === "all"
            ? ALL_GROUPS.map((group) => {
              const rows = shown.filter((v) => videoFilterOf(v.status) === group);
              if (rows.length === 0) return null;
              return (
                <section key={group}>
                  <h3 className="flex justify-between border-b border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--text-2)]">
                    <span>{t(`youtube.tabs.${group}`)}</span>
                    <span className="tabular-nums">{rows.length}</span>
                  </h3>
                  <VideoRows videos={rows} />
                </section>
              );
            })
            : <VideoRows videos={shown} />}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-3.5 py-2 text-[12px] text-[var(--text-3)]">
            <span>{t("youtube.showing", { shown: shown.length, total: visible.length })}</span>
            {shown.length < visible.length && (
              <button type="button" onClick={() => setLimit((n) => n + PAGE_SIZE)} className="min-h-[44px] px-2 font-medium text-[var(--accent)] hover:underline">
                +{Math.min(PAGE_SIZE, visible.length - shown.length)}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VideoRows({ videos }: { videos: YoutubeVideo[] }) {
  return (
    <ul className="divide-y divide-[var(--border)]">
      {videos.map((video) => <VideoRow key={video.video_id} video={video} />)}
    </ul>
  );
}

function VideoRow({ video }: { video: YoutubeVideo }) {
  const { t, i18n } = useTranslation();
  const dim = video.status === "skipped" || video.status === "unavailable";
  const title = video.title || t("youtube.privateOrDeleted");
  const note = video.status === "unavailable"
    ? video.title ? t("youtube.privateOrDeleted") : null
    : video.status === "skipped" && video.skip_kind
      ? t(`youtube.skipKind.${video.skip_kind}`)
      : video.reason;
  const meta = [video.channel, formatDuration(video.duration_s), video.published_at ? t("youtube.posted", { date: shortDate(video.published_at, i18n.language) }) : null, note].filter(Boolean);
  const url = `https://www.youtube.com/watch?v=${video.video_id}`;

  return (
    <li className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 md:grid-cols-[1fr_auto_auto] ${dim ? "opacity-70" : ""}`}>
      <div className="min-w-0">
        <p className="line-clamp-2 text-[14px] font-medium leading-5 text-[var(--text)]">{title}</p>
        <p className="mt-0.5 truncate text-[12px] leading-5 text-[var(--text-3)]">
          {meta.join(" · ")}
          {video.removed_at && <> · <span className="text-[var(--yellow)]">{t("youtube.removedTag")}</span></>}
        </p>
      </div>
      <div className="col-start-1 row-start-2 md:col-start-auto md:row-start-auto">
        <StatusBadge status={videoStatusDescriptor(video.status, t)} compact />
      </div>
      <div className="col-start-2 row-span-2 row-start-1 md:col-start-auto md:row-span-1 md:row-start-auto">
        <RowActionsMenu items={[{ label: t("youtube.openOnYoutube"), onClick: () => window.open(url, "_blank", "noopener,noreferrer") }]} />
      </div>
    </li>
  );
}

function VideoSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-[var(--border)] px-3.5 py-3 last:border-b-0">
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-3/4 rounded bg-[var(--surface-3)]" />
            <div className="h-3 w-1/3 rounded bg-[var(--surface-2)]" />
          </div>
          <div className="h-6 w-24 rounded-full bg-[var(--surface-2)]" />
        </div>
      ))}
    </div>
  );
}
