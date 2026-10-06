export const VIDEO_STATUSES = [
  "new",
  "queued",
  "downloading",
  "transcribing",
  "translating",
  "done",
  "waiting",
  "skipped",
  "unavailable",
  "failed",
] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

// "content": a Short or live stream on a channel whose follow leaves that kind out.
export type SkipKind = "user" | "before_start" | "members_only" | "content";
/** What a channel upload is; null for a playlist entry. */
export type ContentKind = "video" | "short" | "live";
export type UserAction = "download" | "retry" | "skip";

export type Backfill =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "posted_since"; date: string }
  | { kind: "added_since"; date: string };

export const VIDEO_HEIGHTS = [480, 720, 1080, 1440, 2160] as const;
export const VIDEO_CODECS = ["h264", "vp9", "av1", "any"] as const;
export const VIDEO_CONTAINERS = ["mp4", "mkv"] as const;
export const AUDIO_FORMATS = ["m4a", "opus"] as const;
export const PLAYLIST_MODES = ["auto", "manual"] as const;
export const CAPTION_SOURCES = ["prefer_youtube", "whisper_only"] as const;

export type VideoHeight = (typeof VIDEO_HEIGHTS)[number];
export type VideoCodec = (typeof VIDEO_CODECS)[number];
export type VideoContainer = (typeof VIDEO_CONTAINERS)[number];
export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export type PlaylistMode = (typeof PLAYLIST_MODES)[number];
export type CaptionSource = (typeof CAPTION_SOURCES)[number];

export type MediaProfile =
  | { type: "video"; maxHeight: VideoHeight; codec: VideoCodec; container: VideoContainer }
  | { type: "audio"; format: AudioFormat };

export interface ChannelInclude {
  shorts: boolean;
  live: boolean;
}

/** A followed playlist or channel, as stored in the youtube_playlists setting. */
export interface YoutubePlaylist {
  id: string;
  title: string;
  folder: string;
  enabled: boolean;
  mode: PlaylistMode;
  backfill: Backfill;
  media: MediaProfile;
  captions: CaptionSource;
  subtitleTaskIds: number[];
  checkEveryMinutes: number;
  /** For a channel: whether its Shorts and live streams are followed too. Ignored for a playlist. */
  include: ChannelInclude;
}

/** The fields a user sets when following or editing. id and title come from YouTube. */
export type PlaylistFields = Omit<YoutubePlaylist, "id" | "title">;

export interface PlaylistSyncState {
  lastCheckedAt: string | null;
  lastError: string | null;
  /** YouTube's reported playlist_count at the last successful listing. */
  count: number | null;
  /** "public", "unlisted" or "private" as yt-dlp reports it. */
  availability: string | null;
  /** When the first listing was stored. Entries first seen then are the backfill set. */
  firstSyncAt: string | null;
}

export interface PlaylistCounts {
  /** Videos in the playlist now. */
  total: number;
  /** Videos on record that the playlist no longer lists. */
  removed: number;
  /** Every video on the playlist's page by status, removed ones included, as its tabs list them. */
  byStatus: Partial<Record<VideoStatus, number>>;
  /** A channel's listed uploads by kind; empty for a playlist. */
  byKind: Partial<Record<ContentKind, number>>;
}

/** GET /api/youtube/playlists: a followed playlist with its sync state and counts. */
export interface YoutubePlaylistSummary extends YoutubePlaylist {
  sync: Omit<PlaylistSyncState, "firstSyncAt"> & { checking: boolean; nextCheckAt: string | null };
  counts: PlaylistCounts;
}

/** How a video's picked languages were made, kept for the row's summary. */
export interface SubtitlePlan {
  /** The spoken language's key, when known. */
  spoken: string | null;
  routes: { taskId: number; kind: "same" | "captions" | "translate" }[];
}

export type CooldownCause = "rate_limited" | "bot_check";

export interface Cooldown {
  until: string;
  cause: CooldownCause;
  /** Cooldowns since the last successful download; each one doubles the pause. */
  strikes: number;
}

/** A video as GET /api/youtube/playlists/:id/videos returns it. */
export interface YoutubeVideo {
  video_id: string;
  playlist_id: string;
  title: string;
  channel: string | null;
  duration_s: number | null;
  published_at: string | null;
  added_at: string | null;
  status: VideoStatus;
  skip_kind: SkipKind | null;
  content_kind: ContentKind | null;
  reason: string | null;
  attempts: number;
  retry_after: string | null;
  media_path: string | null;
  user_queued_at: string | null;
  position: number | null;
  removed_at: string | null;
  /** Where the transcript came from: "youtube_captions" or "whisper:<model>". */
  transcript_source: string | null;
  /** The spoken language and each picked language's route, once the subtitles are written. */
  subtitles: SubtitlePlan | null;
  /** Download or transcription percentage while running, when the server has one. */
  pct?: number;
}

/** GET /api/youtube/pipeline: what holds the subtitle and translation steps back. */
export interface YoutubePipeline {
  gpu: { shared: boolean; held: boolean; waitingFor: number; translationRunning: boolean };
  transcription: { ready: boolean; waiting: number };
}

export interface YoutubeNotesFolder {
  path: string;
  exists: boolean;
  writable: boolean;
}

/** GET /api/youtube/status. */
export interface YoutubeStatus {
  ytdlp: { available: boolean; version: string | null; path: string | null };
  ffmpeg: { available: boolean; version: string | null };
  apiKey: boolean;
  notes: YoutubeNotesFolder;
  cookies: { present: boolean; updatedAt: string | null };
  cooldown: Pick<Cooldown, "until" | "cause"> | null;
}

export interface YoutubePreviewEntry {
  posted: string | null;
  added: string | null;
  durationS: number | null;
  kind: ContentKind | null;
}

/** POST /api/youtube/playlists/preview. */
export interface YoutubePreview {
  id: string;
  title: string;
  channel: string | null;
  availability: string | null;
  count: number;
  unavailable: number;
  followed: boolean;
  folder: string;
  addedDates: boolean;
  addedDatesError: string | null;
  entries: YoutubePreviewEntry[];
}
