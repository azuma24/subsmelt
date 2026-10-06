/**
 * The API contract lives in src/shared and is typed on both sides. This file
 * re-exports it under the names the client has used, and holds the few types
 * that exist only in the browser.
 */
export type { TranslationTask as Task } from "../shared/tasks";
export type {
  Job,
  JobConnection,
  JobPreview,
  JobsResponse,
  LogRow as LogEntry,
  PreviewLine,
  QueueStatus,
} from "../shared/jobs";
export type {
  FolderNode,
  ScanResult,
  ScannedFile,
  ScannedSubtitle as SubtitleEntry,
  ScannedTask as TaskStatus,
  ScanTaskState,
} from "../shared/scan";
export type {
  LlmConnection,
  LlmConnectionState,
  LlmConnectionStatus,
  LlmHealth,
  LlmMode,
  LlmProvider,
  LlmStatus,
} from "../shared/llm";
export type {
  ModelEngine,
  ModelSupports,
  TranscribePostAction,
  TranscribeRequest,
  TranscribeResponse,
  TranscriptionHealth,
  TranscriptionHistoryEntry,
  TranscriptionOutputFormat,
  TranscriptionPreflightResponse,
  WhisperModelDeleteResult,
  WhisperModelDescriptor,
  WhisperModelDownloadResult,
  WhisperModelInfo as WhisperModel,
} from "../shared/transcription";
export type {
  Backfill as YoutubeBackfill,
  ContentKind as YoutubeContentKind,
  MediaProfile as YoutubeMedia,
  PlaylistFields as YoutubePlaylistFields,
  SubtitlePlan as YoutubeSubtitlePlan,
  UserAction as YoutubeVideoAction,
  VideoStatus as YoutubeVideoStatus,
  YoutubeNotesFolder,
  YoutubePipeline,
  YoutubePlaylistSummary as YoutubePlaylist,
  YoutubePreview,
  YoutubePreviewEntry,
  YoutubeStatus,
  YoutubeVideo,
} from "../shared/youtube";
import type { Cooldown } from "../shared/youtube";

export type YoutubeCooldown = Pick<Cooldown, "until" | "cause">;

/** Where a manual transcription is, as the Transcribe page shows it. */
export type ManualTranscriptionStage =
  | "preflighting"
  | "transcribing"
  | "queueing"
  | "complete"
  | "skipped"
  | "failed"
  | "cancelling"
  | "cancelled";
