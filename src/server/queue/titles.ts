import path from "node:path";
import type { JobRow } from "../db.js";
import type { ResolvedConnection } from "../connections.js";
import { cleanMediaTitle, ensureTranslatedTitle, translateSingle, type UsageEvent } from "../translator.js";
import { stripLangSuffix } from "../scanner.js";
import { logger } from "../logger.js";
import { errorMessage } from "../errors.js";

/** Media base stem for the title sidecar: video stem, else srt stem minus language suffix. */
export function titleBaseForJob(job: JobRow): string {
  if (job.video_path) return path.basename(job.video_path, path.extname(job.video_path));
  return stripLangSuffix(path.basename(job.srt_path, path.extname(job.srt_path)));
}

// Dedicated system prompt for translating a short media title — the subtitle
// prompt template assumes cue-by-cue input and produces noisy output for a
// single title string.
const titleTranslationPrompt = (lang: string) =>
  `Translate the following movie or series title into ${lang}. Return only the translated title, nothing else.`;

export interface TitleTranslationOptions {
  langCode: string;
  targetLang: string;
  connection: ResolvedConnection;
  /** The connection's host, or the configured fallback when it has none. */
  apiHost: string;
  temperature: number;
  disableToolCalls: boolean;
  requestTimeoutMs: number;
  /** Re-translate even when the sidecar already holds a title (a forced job). */
  force?: boolean;
  abortSignal?: AbortSignal;
  onUsage?: (usage: UsageEvent) => void;
}

/**
 * Writes the job's translated title into its folder's sidecar, calling the LLM
 * only when the sidecar holds none (or `force`). Never throws: the title is a
 * nicety beside the subtitle, so a failure is logged and the job stands.
 */
export async function writeJobTitle(
  job: JobRow,
  what: "Title sidecar" | "Title repair",
  opts: TitleTranslationOptions,
): Promise<void> {
  const base = titleBaseForJob(job);
  const { onUsage } = opts;
  try {
    const title = await ensureTranslatedTitle({
      outputDir: path.dirname(job.output_path),
      base,
      langCode: opts.langCode,
      force: opts.force,
      translate: (text) =>
        translateSingle(text, {
          apiKey: opts.connection.apiKey || "",
          apiHost: opts.apiHost,
          model: opts.connection.model || "",
          provider: opts.connection.provider,
          systemPrompt: titleTranslationPrompt(opts.targetLang || "English"),
          temperature: opts.temperature,
          disableToolCalls: opts.disableToolCalls,
          requestTimeoutMs: opts.requestTimeoutMs,
          abortSignal: opts.abortSignal,
          onUsage: onUsage && ((u) => onUsage({ ...u, kind: "title", connection: opts.connection })),
        }),
    });
    if (title !== cleanMediaTitle(base)) {
      logger.info(
        "translate",
        `Translated title (${opts.langCode}): ${title} — ${path.basename(job.srt_path)}`,
        job.id,
        { stage: "title_sidecar", title, langCode: opts.langCode },
      );
    }
  } catch (error) {
    logger.warn("queue", `${what} failed (non-fatal): ${errorMessage(error) || error}`, job.id, {
      stage: "title_sidecar",
    });
  }
}
