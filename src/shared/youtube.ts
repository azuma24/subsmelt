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
  /**
   * Whether a second-brain mirror may copy this playlist's note folder. Notes are
   * written for every playlist either way; this only puts the folder on the
   * GET /api/youtube/second-brain allowlist. Off by default, and turning it off
   * deletes nothing already written or mirrored.
   */
  secondBrainExport: boolean;
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

/**
 * GET /api/youtube/second-brain: the note folders a mirror may copy, relative to
 * the notes folder. A selected folder that also holds, or contains, the notes of
 * an unselected playlist is withheld instead, so sharing a folder never widens
 * what the mirror sees.
 */
export interface YoutubeSecondBrain {
  folders: string[];
  /** Selected playlists whose note folder is withheld. */
  withheld: { id: string; title: string }[];
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

export type YoutubeNotesState = "all" | "saved" | "blocked";

/** A generated note owned by a currently followed playlist. Paths are relative to the notes root. */
export interface YoutubeNote {
  videoId: string;
  title: string;
  channel: string | null;
  playlistId: string;
  playlistTitle: string;
  publishedAt: string | null;
  notePath: string | null;
  exportedAt: string | null;
  status: "saved" | "blocked";
  reason: string | null;
}

/** GET /api/youtube/notes. */
export interface YoutubeNotesList {
  notes: YoutubeNote[];
  total: number;
  health: YoutubeNotesFolder & { blocked: boolean };
  /** Unfiltered export totals for each followed playlist, independent of list pagination. */
  countsByPlaylist: Record<string, { saved: number; blocked: number }>;
}

/** GET /api/youtube/notes/:videoId. */
export interface YoutubeNoteDetail {
  note: YoutubeNote;
  content: string;
}

/**
 * What happened to a video's note. `upsert`: the note at `notePath` was written;
 * fetch its body from GET /api/youtube/notes/:videoId. `unavailable`: SubSmelt
 * cannot write or serve the note for `reason`; keep what you have. `remove`:
 * the note has been missing from the notes folder long enough that SubSmelt
 * no longer expects it back.
 */
export type YoutubeNoteChangeKind = "upsert" | "remove" | "unavailable";

export type YoutubeNoteChangeReason =
  | "notes_root_missing"
  | "notes_root_unwritable"
  | "export_failed"
  | "note_missing"
  | "note_unreadable";

/** One event of GET /api/youtube/notes/changes. Paths are relative to the notes folder; there is never a host path. */
export interface YoutubeNoteChange {
  sequence: number;
  /** The cursor that names this event; `after=` it to continue past it. */
  cursor: string;
  kind: YoutubeNoteChangeKind;
  videoId: string;
  /** The playlist that owned the video's row when the event was recorded. */
  playlistId: string;
  notePath: string | null;
  /** The path a re-export under a new title replaced, when it did. */
  previousNotePath: string | null;
  title: string;
  reason: YoutubeNoteChangeReason | null;
  at: string;
}

/** GET /api/youtube/notes/changes. */
export interface YoutubeNoteChanges {
  generation: string;
  /** The newest event when the page was read; `after=head` returns nothing until the next event. */
  head: string;
  changes: YoutubeNoteChange[];
  nextCursor: string;
  hasMore: boolean;
}

/** GET /api/youtube/notes/sync-state. */
export interface YoutubeNotesSyncState {
  generation: string;
  head: string;
  /** Changes whenever `selection` changes; compare it before diffing the list. */
  selectionRevision: string;
  /** Followed playlists ticked for the knowledge base, with the relative note folder each writes into. */
  selection: { playlistId: string; title: string; folder: string }[];
  notesRoot: { exists: boolean; writable: boolean };
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
