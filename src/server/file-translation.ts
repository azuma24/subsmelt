import fs from "node:fs";
import path from "node:path";
import {
  AUTO_SOURCE_LANGUAGE,
  DEFAULT_OUTPUT_PATTERN,
  createTask,
  getSetting,
  getTask,
  getTasks,
  validateTaskLangCode,
  type TranslationTask,
} from "./config.js";
import { createJob, findJobForTask, findUnfinishedJobForOutput, resetJob } from "./db.js";
import { logger } from "./logger.js";
import { MEDIA_DIR, stripLangSuffix, taskOutputName } from "./scanner.js";
import { assertMediaPathAllowed } from "./transcription-client.js";

export type FileTranslationTarget = { taskId: number } | { langCode: string; targetLang: string };

export type FileTranslationResult =
  | { kind: "queued"; jobId: number; taskId: number }
  | { kind: "already-queued"; jobId: number; taskId: number }
  | { kind: "rejected"; status: 400 | 404 | 409; error: string };

type Rejected = Extract<FileTranslationResult, { kind: "rejected" }>;

const reject = (status: Rejected["status"], error: string): Rejected => ({ kind: "rejected", status, error });

function extensionSetting(key: string): Set<string> {
  return new Set(
    getSetting(key)
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

function checkSource(srtPath: string): Rejected | null {
  try {
    assertMediaPathAllowed(srtPath, MEDIA_DIR);
  } catch {
    return reject(400, "Subtitle must be inside the media folder");
  }
  if (!extensionSetting("subtitle_extensions").has(path.extname(srtPath).toLowerCase()))
    return reject(400, "File is not a subtitle");
  if (!fs.statSync(srtPath, { throwIfNoEntry: false })?.isFile())
    return reject(404, "Subtitle file not found");
  return null;
}

/** A task to translate with: one that exists, or a new one saved only once the request is accepted. */
type ResolvedTask =
  | { kind: "existing"; task: TranslationTask }
  | { kind: "new"; draft: { target_lang: string; lang_code: string; output_pattern: string } };

function resolveTask(target: FileTranslationTarget): ResolvedTask | Rejected {
  if ("taskId" in target) {
    const task = getTask(target.taskId);
    return task ? { kind: "existing", task } : reject(404, "Translation task not found");
  }

  const wanted = target.langCode.toLowerCase();
  const existing = getTasks().find((t) => t.lang_code.toLowerCase() === wanted);
  if (existing) return { kind: "existing", task: existing };

  const langCodeError = validateTaskLangCode(target.langCode);
  if (langCodeError) return reject(400, langCodeError);
  return {
    kind: "new",
    draft: { target_lang: target.targetLang, lang_code: target.langCode, output_pattern: DEFAULT_OUTPUT_PATTERN },
  };
}

/**
 * A language with no task gets a disabled one: the queue runs its jobs, but a
 * library scan never applies it to every subtitle.
 */
function saveTask(resolved: ResolvedTask): TranslationTask {
  if (resolved.kind === "existing") return resolved.task;
  const { draft } = resolved;
  const { lastInsertRowid } = createTask({ ...draft, source_lang: AUTO_SOURCE_LANGUAGE, enabled: 0 });
  logger.info("system", `Created disabled translation task for one-off translations: ${draft.target_lang} (${draft.lang_code})`);
  return getTask(lastInsertRowid)!;
}

/** Same companion rule as the scanner: a video named like the subtitle, with or without its language suffix. */
function findCompanionVideo(srtPath: string): string | null {
  const dir = path.dirname(srtPath);
  const stem = path.basename(srtPath, path.extname(srtPath));
  const stems = new Set([stem, stripLangSuffix(stem)]);
  const videoExts = extensionSetting("video_extensions");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const tryStem of stems) {
    const match = names.find((name) => {
      const ext = path.extname(name);
      return videoExts.has(ext.toLowerCase()) && path.basename(name, ext) === tryStem;
    });
    if (match) return path.join(dir, match);
  }
  return null;
}

/** Queue one library subtitle for translation into one language, without touching the global tasks. */
export function queueFileTranslation(srtPathInput: string, target: FileTranslationTarget): FileTranslationResult {
  // Scan results name subtitles by their resolved path under MEDIA_DIR, and the
  // jobs table keys on that exact string.
  const srtPath = path.resolve(srtPathInput);
  const sourceProblem = checkSource(srtPath);
  if (sourceProblem) return sourceProblem;

  const resolved = resolveTask(target);
  if (resolved.kind === "rejected") return resolved;
  const shape = resolved.kind === "existing" ? resolved.task : resolved.draft;

  const existing = resolved.kind === "existing" ? findJobForTask(srtPath, resolved.task.id) : undefined;
  if (existing?.status === "pending" || existing?.status === "translating")
    return { kind: "already-queued", jobId: existing.id, taskId: existing.task_id };
  if (existing?.status === "done" || existing?.status === "skipped")
    return reject(409, `${path.basename(srtPath)} is already translated to ${shape.lang_code}; use re-translate on its job instead`);

  const outputPath = path.join(path.dirname(srtPath), taskOutputName(srtPath, shape));
  if (outputPath === srtPath) return reject(409, `Translating to ${shape.lang_code} would overwrite the source subtitle`);
  if (fs.existsSync(outputPath)) return reject(409, `${path.basename(outputPath)} already exists`);
  if (findUnfinishedJobForOutput(outputPath, existing?.id ?? null))
    return reject(409, `Another job is already writing ${path.basename(outputPath)}`);

  const task = saveTask(resolved);
  if (existing) {
    if (resetJob(existing.id) === 0) return { kind: "already-queued", jobId: existing.id, taskId: task.id };
    logger.info("queue", `Job #${existing.id} reset to pending (one-off translation)`, existing.id);
    return { kind: "queued", jobId: existing.id, taskId: task.id };
  }

  const { lastInsertRowid } = createJob({
    task_id: task.id,
    srt_path: srtPath,
    output_path: outputPath,
    video_path: findCompanionVideo(srtPath),
    status: "pending",
  });
  const jobId = Number(lastInsertRowid);
  logger.info("queue", `Queued one-off translation of ${path.basename(srtPath)} to ${task.target_lang}`, jobId);
  return { kind: "queued", jobId, taskId: task.id };
}
