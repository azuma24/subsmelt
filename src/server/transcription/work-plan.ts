import path from "node:path";
import { createHash } from "node:crypto";
import { getAllSettings, getTasks, envPinnedSettingKeys } from "../config.js";
import { MEDIA_DIR } from "../scanner.js";
import { parseRules, resolveDirectoryRule } from "../directory-rules.js";
import { parseCorrectionRuleSets } from "../../shared/corrections.js";
import { matchProcessingProfile, parseProcessingProfiles } from "../../shared/processing-profiles.js";
import type { TranslationTask } from "../../shared/tasks.js";
import {
  assertMediaPathAllowed,
  buildTranscriptionRequest,
  buildUrlTranscriptionRequest,
  matchingFolderDefaults,
  resolveTransportMode,
  type BackendTranscriptionRequest,
  type TranscriptionOutputFormat,
} from "../transcription-client.js";
import { overridesFromBody } from "../routes/transcription-runtime.js";
import type { WorkInput } from "./work.js";

export const MAX_REVIEW_BYTES = 4 * 1024 * 1024;

export interface PlannedTarget {
  id: number;
  label: string;
  signature: string;
}

export interface WorkPlan {
  settings: Record<string, string>;
  profile?: { id: string; name: string; folder: string };
  effective: Omit<BackendTranscriptionRequest, "input_path">;
  origins: { folderDefaults: boolean; runOverrides: string[]; environment: string[] };
  targets?: PlannedTarget[];
  review: boolean;
  exportNote: boolean;
  transport?: { mode: "shared" | "upload"; audioOnlyUpload: boolean };
  blockers?: string[];
  quality?: { maxLineWidth?: number; maxReadingSpeed?: number };
}

export function taskSignature(task: TranslationTask): string {
  return createHash("sha256")
    .update(
      JSON.stringify([task.lang_code, task.target_lang, task.source_lang, task.output_pattern, task.prompt_override]),
    )
    .digest("hex");
}

const ADVANCED_KEYS = [
  "beam_size",
  "patience",
  "condition_on_previous_text",
  "word_timestamps",
  "initial_prompt",
  "speaker_diarization",
  "bgm_separation",
] as const;

export function acceptedAdvancedOptions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    ADVANCED_KEYS.filter((key) => ["number", "string", "boolean"].includes(typeof source[key])).map((key) => [
      key,
      source[key],
    ]),
  );
}

export function workOverrides(request: Record<string, unknown>, resolvedAudio?: number) {
  const advancedOptions = acceptedAdvancedOptions(request.advancedOptions);
  return {
    ...(resolvedAudio !== undefined && { audio_stream_index: resolvedAudio }),
    ...overridesFromBody(request),
    ...(advancedOptions && { advanced_options: advancedOptions }),
  };
}

function effectiveRequest(
  item: WorkInput,
  settings: Record<string, string>,
  useOverrides: boolean,
  resolvedAudio?: number,
): WorkPlan["effective"] {
  const { kind, input, request } = item;
  const options = {
    settings,
    ...(useOverrides && {
      outputFormat: request.outputFormat as TranscriptionOutputFormat | undefined,
      overrides: workOverrides(request, resolvedAudio),
    }),
  };
  if (kind === "url") {
    const { url: _url, ...effective } = buildUrlTranscriptionRequest({ ...options, url: input });
    return effective;
  }
  const { input_path: _path, ...effective } = buildTranscriptionRequest({
    ...options,
    videoPath: input,
    mediaDir: MEDIA_DIR,
    postAction: request.postAction === "transcribe_and_translate" ? "transcribe_and_translate" : "transcribe_only",
  });
  return effective;
}

export function createWorkPlan(item: WorkInput, settings = getAllSettings()): WorkPlan {
  const { kind, input, request } = item;
  const localInput = kind === "file" ? assertMediaPathAllowed(input, MEDIA_DIR) : undefined;
  const folder = localInput
    ? path.relative(assertMediaPathAllowed(MEDIA_DIR, MEDIA_DIR), path.dirname(localInput)).split(path.sep).join("/")
    : "";
  const profiles = parseProcessingProfiles(settings.processing_profiles);
  const explicit = typeof request.profileId === "string" ? request.profileId : "";
  const profile = explicit
    ? profiles.find((entry) => entry.id === explicit)
    : kind === "file"
      ? matchProcessingProfile(profiles, folder)
      : undefined;
  if (explicit && !profile) throw new Error("Processing profile was not found");

  const baseline = effectiveRequest(item, settings, false);
  const snapshot = {
    transcription_model: profile?.model ?? baseline.model,
    transcription_language: profile?.language ?? baseline.language,
    transcription_device: baseline.device,
    transcription_compute_type: baseline.compute_type,
    transcription_output_format:
      request.subtitleIntakeRevision && (profile?.outputFormat ?? baseline.output_format) === "txt"
        ? "srt"
        : (profile?.outputFormat ?? baseline.output_format),
    transcription_use_vad: baseline.use_vad ? "1" : "0",
    transcription_max_line_length: String(baseline.subtitle_quality?.max_line_length ?? 0),
    transcription_max_subtitle_duration: String(
      profile?.maxCueDuration ?? baseline.subtitle_quality?.max_subtitle_duration ?? 0,
    ),
    transcription_merge_short_segments: baseline.subtitle_quality?.merge_short_segments ? "1" : "0",
    transcription_advanced_stt: JSON.stringify(baseline.advanced_options ?? {}),
    transcription_folder_defaults: "[]",
    transcription_low_ram_behavior: settings.transcription_low_ram_behavior || "ask",
    transcription_audio_only_upload: settings.transcription_audio_only_upload || "0",
    preferred_chinese: settings.preferred_chinese || "zh-TW",
    correction_rule_sets: JSON.stringify(
      parseCorrectionRuleSets(settings.correction_rule_sets ?? "[]").filter(
        (entry) => !profile?.correctionListIds || profile.correctionListIds.includes(entry.id),
      ),
    ),
  };
  const effective = effectiveRequest(item, { ...settings, ...snapshot }, true, baseline.audio_stream_index);
  if (kind === "url" && request.review === true) throw new Error("Source review requires a Library file");
  const review = kind === "file" && (typeof request.review === "boolean" ? request.review : profile?.review === true);
  const exportNote = typeof request.exportNote === "boolean" ? request.exportNote : profile?.exportNote === true;
  if (review && effective.output_format === "txt") throw new Error("Source review requires SRT, VTT, or ASS output");
  const targeted = kind === "file" && (review || (profile && effective.post_action === "transcribe_and_translate"));
  let targets: PlannedTarget[] | undefined;
  if (targeted) {
    const tasks = getTasks();
    const inherited = resolveDirectoryRule(folder, parseRules(settings.directory_rules || "[]"), false);
    const taskIds =
      profile?.targetTaskIds ??
      tasks.filter((task) => task.enabled || inherited.extraTaskIds.includes(task.id)).map((task) => task.id);
    targets = [...new Set(taskIds)].map((id) => {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) throw new Error(`Translation task ${id} was not found`);
      return { id, label: task.target_lang, signature: taskSignature(task) };
    });
  }

  return {
    settings: snapshot,
    ...(profile && { profile: { id: profile.id, name: profile.name, folder: profile.folder } }),
    effective,
    origins: {
      folderDefaults: Boolean(localInput && matchingFolderDefaults(localInput, MEDIA_DIR, settings)),
      runOverrides: [...Object.keys(workOverrides(request)), ...(request.outputFormat ? ["outputFormat"] : [])],
      environment: envPinnedSettingKeys().filter((key) => key in snapshot),
    },
    targets,
    review,
    exportNote,
    ...(kind === "file" && {
      transport: {
        mode: resolveTransportMode(settings),
        audioOnlyUpload: workOverrides(request).audio_only_upload ?? snapshot.transcription_audio_only_upload === "1",
      },
    }),
    blockers: [
      ...(settings.transcription_enabled !== "1" ? ["speechDisabled"] : []),
      ...(!settings.transcription_backend_url?.trim() ? ["backendMissing"] : []),
    ],
    ...(profile && { quality: { maxLineWidth: profile.maxLineWidth, maxReadingSpeed: profile.maxReadingSpeed } }),
  };
}

/** Keep saved operational defaults and target fingerprints out of the response. */
export function publicWorkPlan(plan: WorkPlan | undefined) {
  if (!plan) return undefined;
  const {
    settings: _settings,
    targets,
    effective: { advanced_options, ...effective },
    ...rest
  } = plan;
  const { initial_prompt: _prompt, ...advanced } = advanced_options ?? {};
  return {
    ...rest,
    effective: { ...effective, ...(advanced_options && { advanced_options: advanced }) },
    targets: targets?.map(({ id, label }) => ({ id, label })),
  };
}
