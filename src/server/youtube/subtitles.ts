import fs from "node:fs";
import path from "node:path";
import { getTask } from "../config.js";
import { createJob } from "../db.js";
import { outputNameFor } from "../scanner.js";
import { copyCookiesInto } from "./cookies.js";
import type { YoutubePlaylist } from "./playlists.js";
import { languageFileCode, languageKey, planSubtitles, spokenCaption, taskLanguageKey, whisperLanguage, type SubtitleRoute } from "./subtitle-routes.js";
import { captionArgs, errorSummary, runYtdlp } from "./ytdlp.js";

const CAPTION_TIMEOUT_MS = 2 * 60_000;

export interface TranscribeRequest {
  mediaPath: string;
  /** Whisper's code for the spoken language, or "auto". */
  language: string;
  durationS: number | null;
}

export interface TranscribeResult {
  /** Where the transcript was written. */
  outputPath: string;
  /** The language Whisper used or detected, when it says. */
  language: string | null;
}

export interface SubtitleDeps {
  /** Writes the creator caption `lang` to `dest`; false when YouTube has none. Runs on the YouTube lane. */
  fetchCaption: (videoId: string, lang: string, dest: string) => Promise<boolean>;
  transcribe: (req: TranscribeRequest) => Promise<TranscribeResult>;
  /** A caption fetch failed. Returning falls back to Whisper or a translation; throwing ends the step. */
  onCaptionError: (lang: string, error: unknown) => void;
}

export interface SubtitleInput {
  videoId: string;
  mediaPath: string;
  durationS: number | null;
  /** The transcript a previous run already wrote, if any. */
  knownTranscript: string | null;
  playlist: Pick<YoutubePlaylist, "captions" | "subtitleTaskIds"> | undefined;
}

export type TranscriptSource = "existing" | "captions" | "whisper";

export interface SubtitleResult {
  transcriptPath: string;
  source: TranscriptSource;
  /** The spoken language's key, when known. */
  spoken: string | null;
  routes: SubtitleRoute[];
  jobsCreated: number;
}

interface InfoLanguages {
  language: string | null;
  captions: string[];
}

function readInfo(stem: string): InfoLanguages {
  try {
    const info = JSON.parse(fs.readFileSync(`${stem}.info.json`, "utf8")) as Record<string, unknown>;
    const subtitles = info.subtitles && typeof info.subtitles === "object" ? Object.keys(info.subtitles) : [];
    return { language: typeof info.language === "string" && info.language ? info.language : null, captions: subtitles };
  } catch {
    return { language: null, captions: [] };
  }
}

const exists = (file: string) => fs.existsSync(file);

/** The language a transcript file is named with: "Talk [id].en.srt" gives "en". */
function suffixLanguage(file: string, stem: string): string | null {
  const suffix = path.basename(file, ".srt").slice(path.basename(stem).length + 1);
  return suffix ? languageKey(suffix) : null;
}

function moveInto(from: string, to: string): void {
  if (from !== to) fs.renameSync(from, to);
}

/**
 * Makes the transcript in the spoken language and every picked subtitle
 * language for one downloaded video. Each output is checked on disk first,
 * so a second run after a crash only does what the first left undone.
 */
export async function produceSubtitles(input: SubtitleInput, deps: SubtitleDeps): Promise<SubtitleResult> {
  const stem = input.mediaPath.slice(0, -path.extname(input.mediaPath).length);
  const info = readInfo(stem);
  const captionLangs = input.playlist?.captions === "whisper_only" ? [] : info.captions;
  let spoken = info.language ? languageKey(info.language) : null;
  const transcriptFor = (key: string | null) => (key ? `${stem}.${languageFileCode(key)}.srt` : `${stem}.srt`);

  let transcriptPath: string | null = null;
  let source: TranscriptSource = "existing";
  if (input.knownTranscript && exists(input.knownTranscript)) {
    transcriptPath = input.knownTranscript;
    spoken ??= suffixLanguage(transcriptPath, stem);
  } else if (spoken && exists(transcriptFor(spoken))) {
    transcriptPath = transcriptFor(spoken);
  }

  const caption = spokenCaption(info.language, captionLangs);
  if (!transcriptPath && caption) {
    const dest = transcriptFor(spoken);
    if (await fetchOrReport(deps, input.videoId, caption, dest)) {
      transcriptPath = dest;
      source = "captions";
    }
  }

  if (!transcriptPath) {
    const result = await deps.transcribe({
      mediaPath: input.mediaPath,
      language: (spoken && whisperLanguage(spoken)) || "auto",
      durationS: input.durationS,
    });
    spoken ??= result.language ? languageKey(result.language) : null;
    transcriptPath = transcriptFor(spoken);
    moveInto(result.outputPath, transcriptPath);
    source = "whisper";
  }

  const tasks = (input.playlist?.subtitleTaskIds ?? []).map((id) => getTask(id)).filter((task) => task !== undefined);
  const routes = planSubtitles(spoken, tasks.map((task) => ({ taskId: task.id, lang: taskLanguageKey(task) })), captionLangs);
  let jobsCreated = 0;
  for (const route of routes) {
    const task = tasks.find((t) => t.id === route.taskId)!;
    const outputPath = path.join(path.dirname(stem), outputNameFor(path.basename(stem), task, "srt"));
    if (outputPath === transcriptPath || exists(outputPath)) continue;
    if (route.kind === "same") {
      fs.copyFileSync(transcriptPath, outputPath);
      continue;
    }
    if (route.kind === "captions" && (await fetchOrReport(deps, input.videoId, route.captionLang, outputPath))) continue;
    const created = createJob({ task_id: task.id, srt_path: transcriptPath, output_path: outputPath, video_path: input.mediaPath });
    jobsCreated += created.changes;
  }
  return { transcriptPath, source, spoken, routes, jobsCreated };
}

async function fetchOrReport(deps: SubtitleDeps, videoId: string, lang: string, dest: string): Promise<boolean> {
  try {
    return await deps.fetchCaption(videoId, lang, dest);
  } catch (error) {
    deps.onCaptionError(lang, error);
    return false;
  }
}

/** Downloads one creator caption with yt-dlp into `dest`, through a scratch folder. */
export async function fetchCaptionWithYtdlp(videoId: string, lang: string, dest: string, tmpDir: string): Promise<boolean> {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const outDir = path.join(tmpDir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const cookies = copyCookiesInto(tmpDir);
    const result = await runYtdlp(
      captionArgs({ videoId, lang, tmpDir: path.join(tmpDir, "part"), homeDir: outDir, cookiesPath: cookies ?? undefined }),
      { timeoutMs: CAPTION_TIMEOUT_MS },
    );
    if (result.timedOut) throw new Error("Caption download timed out");
    if (result.code !== 0) throw new Error(errorSummary(result.stderr, result.code));
    const file = fs.readdirSync(outDir).find((name) => name.endsWith(".srt"));
    if (!file) return false;
    fs.copyFileSync(path.join(outDir, file), dest);
    return true;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
