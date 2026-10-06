import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { ModalShell } from "../../components/ModalShell";
import { getErrorMessage } from "../../lib";
import type { Task, YoutubeBackfill, YoutubeMedia, YoutubePlaylist, YoutubePlaylistFields, YoutubePreview } from "../../types";
import { FORM_CONTROL_CLS, FORM_LABEL_CLS } from "../../ui/form-classes";
import { ActionButton } from "../../ui/primitives";
import { Segmented } from "./parts";
import { availabilityLabel, followKind, followUrl, type FollowKind } from "./format";
import { estimateSelection, formatGigabytes, includedEntries, postedPerMonth } from "./estimate";
import { MonthPicker, monthKey, type YearMonth } from "./MonthPicker";

type BackfillKind = YoutubeBackfill["kind"];
type VideoMedia = Extract<YoutubeMedia, { type: "video" }>;

const CHECK_INTERVALS = [15, 60, 360, 1440] as const;
// Above this many videos a save has to be confirmed, so a big channel is never bulk-downloaded by one click.
const LARGE_DOWNLOAD = 100;
// A channel's include switch and the kind of upload it covers.
const INCLUDE_KINDS = [["shorts", "short"], ["live", "live"]] as const;
const HEIGHTS: VideoMedia["maxHeight"][] = [480, 720, 1080, 1440, 2160];
const DEFAULT_VIDEO: VideoMedia = { type: "video", maxHeight: 1080, codec: "h264", container: "mp4" };

interface FollowPlaylistDialogProps {
  /** Present when editing a followed playlist; absent when following a new one. */
  playlist?: YoutubePlaylist;
  /** What a new follow is for; an edit takes it from the playlist. */
  kind?: FollowKind;
  tasks: Task[];
  hasApiKey: boolean;
  folderRoot: string;
  onClose: () => void;
  onOpenSettings: () => void;
  onSaved: (playlistId: string, title: string, created: boolean) => void;
}

function currentMonth(): YearMonth {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function previousMonth({ year, month }: YearMonth): YearMonth {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function monthFromDate(date: string): YearMonth {
  const [year, month] = date.split("-").map(Number);
  return { year, month };
}

function Field({ label, htmlFor, children, className = "" }: { label: string; htmlFor: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className={FORM_LABEL_CLS}>{label}</label>
      {children}
    </div>
  );
}

const hintCls = "text-xs leading-5 text-[var(--text-3)]";
const selectCls = `${FORM_CONTROL_CLS} min-h-touch`;

export function FollowPlaylistDialog({ playlist, kind: newKind = "playlist", tasks, hasApiKey, folderRoot, onClose, onOpenSettings, onSaved }: FollowPlaylistDialogProps) {
  const { t } = useTranslation();
  const kind = playlist ? followKind(playlist.id) : newKind;
  const isChannel = kind === "channel";
  // Channel wording where it differs; everything else is shared with playlists.
  const say = (key: string) => t(isChannel ? `youtube.dialog.channel.${key}` : `youtube.dialog.${key}`);
  const ids = { title: useId(), url: useId(), keep: useId(), existing: useId(), confirm: useId(), include: useId(), langs: useId(), fmt: useId(), height: useId(), codec: useId(), file: useId(), mode: useId(), subs: useId(), every: useId(), folder: useId() };
  const editing = Boolean(playlist);
  const today = currentMonth();
  const enabledTasks = tasks.filter((task) => task.enabled === 1);

  const [url, setUrl] = useState(playlist ? followUrl(playlist.id) : "");
  const [preview, setPreview] = useState<YoutubePreview | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [media, setMedia] = useState<YoutubeMedia>(playlist?.media ?? { type: "audio", format: "m4a" });
  const [lastVideo, setLastVideo] = useState<VideoMedia>(playlist?.media.type === "video" ? playlist.media : DEFAULT_VIDEO);
  const initialBackfill = playlist?.backfill ?? { kind: "none" };
  const [backfillKind, setBackfillKind] = useState<BackfillKind>(initialBackfill.kind);
  const [since, setSince] = useState<YearMonth>("date" in initialBackfill ? monthFromDate(initialBackfill.date) : previousMonth(today));
  const [taskIds, setTaskIds] = useState<number[]>(playlist?.subtitleTaskIds ?? enabledTasks.map((task) => task.id));
  const [mode, setMode] = useState(playlist?.mode ?? "auto");
  const [captions, setCaptions] = useState(playlist?.captions ?? "prefer_youtube");
  const [every, setEvery] = useState(playlist?.checkEveryMinutes ?? 60);
  const [folder, setFolder] = useState(playlist?.folder ?? "");
  // The folder a lookup filled in, so a new lookup can replace it without overwriting one the user typed.
  const autoFolderRef = useRef<string | null>(null);
  const urlRef = useRef(url);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  const [include, setInclude] = useState(playlist?.include ?? { shorts: false, live: false });

  const backfill: YoutubeBackfill = backfillKind === "posted_since" || backfillKind === "added_since"
    ? { kind: backfillKind, date: `${monthKey(since)}-01` }
    : { kind: backfillKind };
  // A channel's added date is its upload date, so Added since would repeat Posted since.
  const addedAvailable = hasApiKey && (editing || preview?.addedDates !== false);
  const offerAdded = !isChannel;
  const entries = useMemo(() => includedEntries(preview?.entries ?? [], include), [preview, include]);
  const monthCounts = useMemo(() => postedPerMonth(entries), [entries]);
  const estimate = preview ? estimateSelection(entries, backfill, media) : null;
  // How many Shorts and live streams the channel has: from the preview when following, from the list when editing.
  const kindCount = (kind: "short" | "live") =>
    preview ? preview.entries.filter((e) => e.kind === kind).length : playlist?.counts.byKind[kind] ?? 0;

  const lookUp = async () => {
    setLookingUp(true);
    setLookupError(null);
    const requested = url;
    try {
      const result = await api.previewYoutubePlaylist(requested, kind);
      if (urlRef.current !== requested) return;
      setPreview(result);
      if (!folder || folder === autoFolderRef.current) {
        setFolder(result.folder);
        autoFolderRef.current = result.folder;
      }
    } catch (error) {
      if (urlRef.current !== requested) return;
      setPreview(null);
      setLookupError(getErrorMessage(error));
    } finally {
      setLookingUp(false);
    }
  };

  const chooseMediaType = (type: YoutubeMedia["type"]) => {
    if (type === media.type) return;
    if (media.type === "video") setLastVideo(media);
    setMedia(type === "audio" ? { type: "audio", format: "m4a" } : lastVideo);
  };
  const setVideo = (patch: Partial<VideoMedia>) => media.type === "video" && setMedia({ ...media, ...patch });
  const toggleTask = (id: number) => setTaskIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const fields: YoutubePlaylistFields = {
    folder: folder.trim() || preview?.folder || playlist?.folder || "",
    enabled: playlist?.enabled ?? true,
    mode,
    backfill,
    media,
    captions,
    subtitleTaskIds: taskIds,
    checkEveryMinutes: every,
    include,
  };
  // Videos this save can start downloading: the preview's estimate for a new follow; for an
  // edit that widens the backfill, at most the ones skipped so far.
  const backfillChanged = playlist !== undefined && JSON.stringify(backfill) !== JSON.stringify(playlist.backfill);
  // Turning a kind on applies the backfill to it, so it can release that many too.
  const turnedOn = INCLUDE_KINDS.filter(([key]) => playlist && include[key] && !playlist.include[key]).map(([, kind]) => kind);
  const atStake = playlist
    ? (backfillChanged && backfill.kind !== "none" ? playlist.counts.byStatus.skipped ?? 0 : 0)
      + (backfill.kind !== "none" ? turnedOn.reduce((sum, kind) => sum + kindCount(kind), 0) : 0)
    : estimate?.videos ?? 0;
  const needsConfirm = atStake > LARGE_DOWNLOAD;
  const canSubmit = (editing || (preview !== null && !preview.followed)) && (!needsConfirm || confirmedCount === atStake);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (playlist) {
        const { backfill: nextBackfill, ...rest } = fields;
        await api.updateYoutubePlaylist(playlist.id, rest);
        if (JSON.stringify(nextBackfill) !== JSON.stringify(playlist.backfill)) await api.changeYoutubeBackfill(playlist.id, nextBackfill);
        onSaved(playlist.id, playlist.title, false);
      } else if (preview) {
        await api.followYoutubePlaylist({ url: preview.id, title: preview.title, ...fields });
        onSaved(preview.id, preview.title, true);
      }
    } catch (error) {
      setSaveError(getErrorMessage(error));
      setSaving(false);
      void queryClient.invalidateQueries({ queryKey: ["youtube"] });
    }
  };

  const estimateText = !estimate
    ? null
    : estimate.videos === 0
      ? say("estimateNothing")
      : t(estimate.approximate ? "youtube.dialog.estimateAbout" : "youtube.dialog.estimate", {
        videos: estimate.videos,
        hours: estimate.hours.toFixed(1),
        size: formatGigabytes(estimate.gigabytes),
      });

  return (
    <ModalShell
      onClose={onClose}
      labelledBy={ids.title}
      overlayClassName="fixed inset-0 z-50 flex items-stretch justify-center bg-scrim md:items-center md:p-6"
      panelClassName="flex w-full flex-col overflow-hidden bg-[var(--surface)] outline-none md:max-h-[90dvh] md:max-w-[640px] md:rounded-md md:border md:border-[var(--border)]"
    >
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4">
        <h3 id={ids.title} className="text-base font-semibold text-[var(--text)]">
          {playlist ? t("youtube.dialog.editTitle", { title: playlist.title }) : say("title")}
        </h3>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="flex h-11 w-11 items-center justify-center rounded-sm text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]">✕</button>
      </div>

      <form id={`${ids.title}-form`} onSubmit={submit} className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <div>
          <label htmlFor={ids.url} className={FORM_LABEL_CLS}>{say("link")}</label>
          <div className="flex gap-2">
            <input
              id={ids.url}
              type={isChannel ? "text" : "url"}
              value={url}
              readOnly={editing}
              onChange={(e) => {
                setUrl(e.target.value);
                urlRef.current = e.target.value;
                setPreview(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !editing) {
                  e.preventDefault();
                  void lookUp();
                }
              }}
              placeholder={isChannel ? "https://www.youtube.com/@…" : "https://www.youtube.com/playlist?list=…"}
              className={`${FORM_CONTROL_CLS} min-h-touch min-w-0 flex-1 ${editing ? "text-[var(--text-2)]" : ""}`}
            />
            {!editing && (
              <ActionButton variant="ghost" onClick={() => void lookUp()} disabled={!url.trim()} busy={lookingUp}>
                {lookingUp ? t("youtube.dialog.lookingUp") : t("youtube.dialog.lookUp")}
              </ActionButton>
            )}
          </div>
          {!editing && <p className={`mt-1 ${hintCls}`}>{say("linkHint")}</p>}
          {lookupError && <p role="alert" className="mt-1 text-xs leading-5 text-[var(--red)]"><span aria-hidden="true">✕ </span>{lookupError}</p>}
        </div>

        {preview && (
          <div className={`flex gap-3 rounded-md border px-4 py-3 ${preview.followed ? "border-[var(--yellow-border)] bg-[var(--yellow-dim)]" : "border-[var(--green-border)] bg-[var(--green-dim)]"}`}>
            <span aria-hidden="true" className={preview.followed ? "text-[var(--yellow)]" : "text-[var(--green)]"}>{preview.followed ? "!" : "✓"}</span>
            <div className="min-w-0 text-sm leading-6 text-[var(--text)]">
              <b className="font-semibold">{preview.title}</b>
              {[availabilityLabel(preview.availability, t), preview.channel && preview.channel !== preview.title ? t("youtube.dialog.by", { channel: preview.channel }) : null].filter(Boolean).map((part) => ` · ${part}`)}
              <p className={hintCls}>
                {preview.followed ? say("alreadyFollowed") : t("youtube.dialog.videosSummary", { count: preview.count, unavailable: preview.unavailable })}
              </p>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <span id={ids.keep} className={FORM_LABEL_CLS}>{t("youtube.dialog.keep")}</span>
          <Segmented
            labelId={ids.keep}
            value={media.type}
            onChange={chooseMediaType}
            options={[
              { value: "audio", label: t("youtube.dialog.audio"), hint: t("youtube.dialog.audioHint") },
              { value: "video", label: t("youtube.dialog.video"), hint: t("youtube.dialog.videoHint") },
            ]}
          />
          {media.type === "audio" ? (
            <Field label={t("youtube.dialog.format")} htmlFor={ids.fmt} className="md:max-w-[200px]">
              <select id={ids.fmt} className={selectCls} value={media.format} onChange={(e) => setMedia({ type: "audio", format: e.target.value as "m4a" | "opus" })}>
                <option value="m4a">m4a (AAC)</option>
                <option value="opus">opus</option>
              </select>
            </Field>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
              <Field label={t("youtube.dialog.quality")} htmlFor={ids.height}>
                <select id={ids.height} className={selectCls} value={media.maxHeight} onChange={(e) => setVideo({ maxHeight: Number(e.target.value) as VideoMedia["maxHeight"] })}>
                  {HEIGHTS.map((h) => <option key={h} value={h}>{h}p</option>)}
                </select>
              </Field>
              <Field label={t("youtube.dialog.codec")} htmlFor={ids.codec}>
                <select id={ids.codec} className={selectCls} value={media.codec} onChange={(e) => setVideo({ codec: e.target.value as VideoMedia["codec"] })}>
                  <option value="h264">{t("youtube.dialog.codecH264")}</option>
                  <option value="vp9">VP9</option>
                  <option value="av1">AV1</option>
                  <option value="any">{t("youtube.dialog.codecAny")}</option>
                </select>
              </Field>
              <Field label={t("youtube.dialog.file")} htmlFor={ids.file}>
                <select id={ids.file} className={selectCls} value={media.container} onChange={(e) => setVideo({ container: e.target.value as VideoMedia["container"] })}>
                  <option value="mp4">mp4</option>
                  <option value="mkv">mkv</option>
                </select>
              </Field>
            </div>
          )}
        </div>

        {isChannel && (
          <div className="space-y-2">
            <span id={ids.include} className={FORM_LABEL_CLS}>{t("youtube.dialog.channel.include")}</span>
            <div role="group" aria-labelledby={ids.include} className="flex flex-wrap gap-2">
              {INCLUDE_KINDS.map(([key, kind]) => (
                <label key={key} className="flex min-h-touch cursor-pointer items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-dim)]">
                  <input type="checkbox" checked={include[key]} onChange={(e) => setInclude({ ...include, [key]: e.target.checked })} className="accent-[var(--accent)]" />
                  {t(`youtube.dialog.channel.${key}`)}
                  {(preview || editing) && <span className="tabular-nums text-[var(--text-3)]">{kindCount(kind)}</span>}
                </label>
              ))}
            </div>
            <p className={hintCls}>{t("youtube.dialog.channel.includeHint")}</p>
          </div>
        )}

        <div className="space-y-3">
          <span id={ids.existing} className={FORM_LABEL_CLS}>{say("existing")}</span>
          <Segmented
            labelId={ids.existing}
            value={backfillKind}
            onChange={setBackfillKind}
            options={[
              { value: "all", label: t("youtube.dialog.all") },
              { value: "none", label: t("youtube.dialog.none") },
              { value: "posted_since", label: t("youtube.dialog.postedSince") },
              ...(offerAdded
                ? [{
                  value: "added_since" as const,
                  label: t("youtube.dialog.addedSince"),
                  hint: addedAvailable ? undefined : t("youtube.dialog.needsKey"),
                  disabled: !addedAvailable,
                }]
                : []),
            ]}
          />
          {(backfillKind === "posted_since" || backfillKind === "added_since") && (
            <div className="flex items-center gap-2">
              <span className={hintCls}>{t("youtube.dialog.from")}</span>
              <MonthPicker value={since} onChange={setSince} counts={monthCounts} today={today} />
            </div>
          )}
          {!hasApiKey && offerAdded && (
            <p className={hintCls}>
              {t("youtube.dialog.addedHint")}{" "}
              <button type="button" onClick={onOpenSettings} className="min-h-touch font-medium text-[var(--accent)] hover:underline">{t("youtube.dialog.openSettings")}</button>
            </p>
          )}
          {preview?.addedDatesError && <p className="text-xs leading-5 text-[var(--yellow)]">{t("youtube.dialog.addedUnavailable", { error: preview.addedDatesError })}</p>}
          {estimateText && (
            <div aria-live="polite" className="rounded-sm bg-[var(--surface-2)] px-3 py-2 text-sm leading-6 text-[var(--text)]">
              {estimateText}
              {estimate?.approximate && estimate.videos > 0 && <p className={hintCls}>{t("youtube.dialog.estimateAboutNote")}</p>}
            </div>
          )}
          {backfillKind === "none" && <p className={hintCls}>{t("youtube.dialog.pickLater")}</p>}
          {needsConfirm && (
            <label htmlFor={ids.confirm} className="flex min-h-touch cursor-pointer items-center gap-3 rounded-sm border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-3 text-sm text-[var(--text)]">
              <input
                id={ids.confirm}
                type="checkbox"
                checked={confirmedCount === atStake}
                onChange={(e) => setConfirmedCount(e.target.checked ? atStake : null)}
                className="accent-[var(--accent)]"
              />
              {t(editing ? "youtube.dialog.confirmLargeEdit" : "youtube.dialog.confirmLarge", { count: atStake })}
            </label>
          )}
          <p className={hintCls}>{say("laterKept")}</p>
        </div>

        <div className="space-y-3">
          <span id={ids.langs} className={FORM_LABEL_CLS}>{t("youtube.dialog.subtitlesIn")}</span>
          {enabledTasks.length === 0 ? (
            <p className={hintCls}>{t("youtube.dialog.noLanguages")}</p>
          ) : (
            <div role="group" aria-labelledby={ids.langs} className="flex flex-wrap gap-2">
              {enabledTasks.map((task) => (
                <label key={task.id} className="flex min-h-touch cursor-pointer items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-dim)]">
                  <input type="checkbox" checked={taskIds.includes(task.id)} onChange={() => toggleTask(task.id)} className="accent-[var(--accent)]" />
                  {task.target_lang}
                </label>
              ))}
            </div>
          )}
          <ul aria-label={t("youtube.dialog.routesLabel")} className="space-y-1 rounded-sm border border-[var(--border)] px-3 py-2">
            {([["=", "routeSame"], ["cc", "routeCaptions"], ["→", "routeTranslate"]] as const).map(([glyph, key]) => (
              <li key={key} className="flex gap-3 text-xs leading-5 text-[var(--text-2)]">
                <span aria-hidden="true" className="w-5 shrink-0 text-center font-mono text-[var(--text-3)]">{glyph}</span>
                {t(`youtube.dialog.${key}`)}
              </li>
            ))}
          </ul>
          <p className={hintCls}>{t("youtube.dialog.languagesHint")}</p>
        </div>

        <details className="rounded-sm border border-[var(--border)] px-3">
          <summary className="flex min-h-touch cursor-pointer items-center text-sm font-medium text-[var(--text)]">{t("youtube.dialog.more")}</summary>
          <div className="grid grid-cols-1 gap-3 pb-3 md:grid-cols-2">
            <Field label={t("youtube.dialog.modeLabel")} htmlFor={ids.mode}>
              <select id={ids.mode} className={selectCls} value={mode} onChange={(e) => setMode(e.target.value as "auto" | "manual")}>
                <option value="auto">{t("youtube.dialog.modeAuto")}</option>
                <option value="manual">{t("youtube.dialog.modeManual")}</option>
              </select>
            </Field>
            <Field label={t("youtube.dialog.captionsLabel")} htmlFor={ids.subs}>
              <select id={ids.subs} className={selectCls} value={captions} onChange={(e) => setCaptions(e.target.value as "prefer_youtube" | "whisper_only")}>
                <option value="prefer_youtube">{t("youtube.dialog.captionsPrefer")}</option>
                <option value="whisper_only">{t("youtube.dialog.captionsWhisper")}</option>
              </select>
            </Field>
            <Field label={t("youtube.dialog.everyLabel")} htmlFor={ids.every}>
              <select id={ids.every} className={selectCls} value={every} onChange={(e) => setEvery(Number(e.target.value))}>
                {[...new Set([...CHECK_INTERVALS, every])].map((minutes) => (
                  <option key={minutes} value={minutes}>{t(`youtube.dialog.every${minutes}`, { defaultValue: `${minutes} min` })}</option>
                ))}
              </select>
            </Field>
            <Field label={t("youtube.dialog.folder")} htmlFor={ids.folder}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 max-w-[45%] shrink truncate font-mono text-xs text-[var(--text-3)]" dir="rtl" title={folderRoot}><bdi>{folderRoot}</bdi></span><span className="-ml-1 font-mono text-xs text-[var(--text-3)]">/</span>
                <input id={ids.folder} className={`${FORM_CONTROL_CLS} min-h-touch min-w-0`} value={folder} onChange={(e) => setFolder(e.target.value)} />
              </div>
            </Field>
          </div>
        </details>
        {saveError && <p role="alert" className="text-xs leading-5 text-[var(--red)]"><span aria-hidden="true">✕ </span>{saveError}</p>}
      </form>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
        <button type="button" onClick={onClose} className="min-h-touch rounded-sm px-4 text-sm font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          form={`${ids.title}-form`}
          disabled={!canSubmit || saving}
          className="inline-flex min-h-touch items-center justify-center rounded-sm bg-[var(--accent)] px-4 text-sm font-medium text-[var(--on-accent)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {saving ? t("common.saving") : editing ? t("common.save") : say("submit")}
        </button>
      </div>
    </ModalShell>
  );
}
