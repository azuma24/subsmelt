import { readdir } from "node:fs/promises";
import path from "node:path";
import { canProbeEmbeddedSubtitles, type EmbeddedSubtitleProbe } from "../shared/embedded-subtitles.js";
import type { SubtitleIntakeDecision, SubtitleIntakeRule } from "../shared/subtitle-intake.js";
import {
  allowsSubtitleFormat,
  checkDestination,
  embeddedVideoIdentity,
  EmbeddedSubtitleError,
  extractTrack,
  probeVideo,
  VIDEO_SETTLE_MS,
} from "./embedded-subtitles.js";
import { getSetting } from "./config.js";
import { errorMessage } from "./errors.js";
import { logger } from "./logger.js";
import { stripLangSuffix } from "./output-names.js";
import { noSpeechVideos } from "./transcription-history.js";
import { hasValidSubtitleText, readSubtitleText } from "./subtitle-text.js";
import { languageKey, preferredChineseKey, type PreferredChinese } from "./youtube/subtitle-routes.js";

const MAX_CACHE_ENTRIES = 2_048;
const MAX_PROBES = 3;
const probeCache = new Map<string, EmbeddedSubtitleProbe>();
const pendingProbes = new Map<string, Promise<EmbeddedSubtitleProbe>>();
const waitingProbes: (() => void)[] = [];
let runningProbes = 0;

function rememberProbe(file: string, probe: EmbeddedSubtitleProbe): void {
  probeCache.delete(file);
  probeCache.set(file, probe);
  if (probeCache.size > MAX_CACHE_ENTRIES) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) probeCache.delete(oldest);
  }
}

function cachedProbe(
  file: string,
  revision: string,
  cachedAtStart: ReadonlyMap<string, EmbeddedSubtitleProbe>,
): Promise<EmbeddedSubtitleProbe> {
  const cached = probeCache.get(file) ?? cachedAtStart.get(file);
  if (cached?.revision === revision) {
    rememberProbe(file, cached);
    return Promise.resolve(cached);
  }
  const key = `${file}\0${revision}`;
  const pending = pendingProbes.get(key);
  if (pending) return pending;

  const probe = (async () => {
    if (runningProbes === MAX_PROBES) await new Promise<void>((resolve) => waitingProbes.push(resolve));
    else runningProbes++;
    try {
      const result = await probeVideo(file, { requireClean: true });
      if (result.revision !== revision) throw new EmbeddedSubtitleError(412, "The video changed.");
      rememberProbe(file, result);
      return result;
    } finally {
      pendingProbes.delete(key);
      const next = waitingProbes.shift();
      if (next) next();
      else runningProbes--;
    }
  })();
  pendingProbes.set(key, probe);
  return probe;
}

export function matchSubtitleIntakeRule(relativeFolder: string, rules: SubtitleIntakeRule[]) {
  return rules.find(
    ({ path: folder }) => folder === "" || relativeFolder === folder || relativeFolder.startsWith(`${folder}/`),
  );
}

export function intakeCompanionStem(subtitle: string): string {
  return stripLangSuffix(path.parse(subtitle).name.replace(/\.(?:forced|signs|songs)$/i, ""));
}

function isIntakeCompanion(video: string, subtitle: string): boolean {
  const stem = path.parse(video).name;
  return path.parse(subtitle).name === stem || intakeCompanionStem(subtitle) === stem;
}

function subtitleTraits(video: string, subtitle: string) {
  const videoStem = path.parse(video).name;
  const subtitleStem = path.parse(subtitle).name;
  if (!subtitleStem.startsWith(`${videoStem}.`)) return { language: "", forced: false };
  const parts = subtitleStem.slice(videoStem.length + 1).split(".");
  const forced = parts.some((part) => /^(forced|signs|songs)$/i.test(part));
  return { language: stripLangSuffix(subtitleStem) === videoStem ? parts[0] : "", forced };
}

function titleIsForced(title: string | null): boolean {
  return /\bforced\b|^\s*(?:signs(?:\s*(?:&|and)\s*songs)?|songs\s*(?:&|and)\s*signs|foreign parts)(?:\s+only)?\s*$/i.test(
    title ?? "",
  );
}

interface SubtitleIntakeOptions {
  video: string;
  sources: string[];
  allSidecars: string[];
  rule: SubtitleIntakeRule;
  preferredChinese: PreferredChinese;
  run: boolean;
  transcriptionAvailable: boolean;
  signal?: AbortSignal;
}

export function createSubtitleIntakeDecider() {
  // A walk larger than the LRU could otherwise evict every unchanged probe
  // before reaching its video. Keep a bounded snapshot for this walk.
  const cachedAtStart = new Map(probeCache);
  return (options: SubtitleIntakeOptions) => decideSubtitleIntake(options, cachedAtStart);
}

async function decideSubtitleIntake(
  options: SubtitleIntakeOptions,
  cachedAtStart: ReadonlyMap<string, EmbeddedSubtitleProbe>,
): Promise<SubtitleIntakeDecision> {
  const { video, sources, allSidecars, rule, signal } = options;
  signal?.throwIfAborted();
  const language = languageKey(rule.language);
  const decision = (
    action: SubtitleIntakeDecision["action"],
    extra: Omit<SubtitleIntakeDecision, "action" | "language"> = {},
  ): SubtitleIntakeDecision => ({ action, language, ...extra });
  const matches = (label: string) => {
    const key = languageKey(label);
    return (
      key === language ||
      (language === "zh" && key.startsWith("zh-")) ||
      (key === "zh" && language === preferredChineseKey(options.preferredChinese))
    );
  };

  let invalidSidecar = false;
  for (const subtitle of [...sources].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const traits = subtitleTraits(video, subtitle);
    if (traits.forced || !matches(traits.language)) continue;
    try {
      if (hasValidSubtitleText(await readSubtitleText(subtitle), path.extname(subtitle).slice(1).toLowerCase())) {
        return decision("sidecar", { file: path.basename(subtitle) });
      }
    } catch {
      // Missing, oversized, unsupported, unreadable or non-UTF-8 sidecar.
    }
    signal?.throwIfAborted();
    invalidSidecar = true;
  }

  if (!canProbeEmbeddedSubtitles(video)) return decision("unsupported");
  let probe: EmbeddedSubtitleProbe;
  try {
    const identity = await embeddedVideoIdentity(video);
    signal?.throwIfAborted();
    if (Date.now() - identity.changedAt < VIDEO_SETTLE_MS) return decision("settling");
    probe = await cachedProbe(video, identity.revision, cachedAtStart);
  } catch (error) {
    signal?.throwIfAborted();
    return decision(error instanceof EmbeddedSubtitleError && error.status === 412 ? "settling" : "probe_failed");
  }
  signal?.throwIfAborted();
  const forced = (track: EmbeddedSubtitleProbe["tracks"][number]) => track.isForced || titleIsForced(track.title);
  const full = probe.tracks.filter((track) => !forced(track));
  const matching = full.filter((track) => track.language && matches(track.language));
  const unknown = full.some((track) => !track.language);
  if (matching.length > 1 || unknown) return decision("ambiguous");
  const selected = matching[0];
  if (selected) {
    if (selected.isBitmap) return decision("bitmap");
    if (!selected.format || !allowsSubtitleFormat(selected.format)) return decision("unsupported");
    const track = probe.tracks.indexOf(selected) + 1;
    try {
      if (!options.run) {
        checkDestination(video, selected, selected.format);
        return decision("embedded", { track, revision: probe.revision });
      }
      const result = await extractTrack(video, probe.revision, selected, { validateTiming: true, signal });
      return decision("imported", { track, file: result.file });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof EmbeddedSubtitleError && error.status === 409) return decision("invalid_sidecar");
      if (options.run)
        logger.warn("scan", `Could not import subtitle for ${path.basename(video)}: ${errorMessage(error)}`);
      return decision("import_failed", { track });
    }
  }

  if (invalidSidecar) return decision("invalid_sidecar");
  const sidecars = allSidecars.map((subtitle) => subtitleTraits(video, subtitle));
  if (full.length || sidecars.some(({ forced, language }) => !forced && language && !matches(language))) {
    return decision("language_mismatch");
  }
  if (sidecars.some(({ forced }) => !forced)) return decision("ambiguous");
  if (probe.tracks.length || sidecars.length) return decision("forced_only");
  if (rule.fallback === "off") return decision("absent");
  if (!options.transcriptionAvailable) return decision("asr_unavailable");
  if (noSpeechVideos.has(video)) return decision("no_speech");
  return decision(rule.fallback, { revision: probe.revision });
}

/** Recheck before enqueue and again before ASR: a new sibling invalidates confirmed absence. */
export async function assertSubtitleIntakeStillMissing(
  file: string,
  revision: string,
  subtitleExtensions = getSetting("subtitle_extensions"),
): Promise<void> {
  const { revision: current } = await embeddedVideoIdentity(file);
  if (current !== revision) throw new Error("The video changed after subtitle intake.");
  const dir = path.dirname(file);
  const entries = await readdir(dir, { withFileTypes: true });
  const fixedFormats = new Set(["srt", "ass", "ssa", "vtt", "sub", "idx", "sup"]);
  const extensions = new Set(
    subtitleExtensions
      .split(",")
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    entries.some((entry) => {
      const ext = path.extname(entry.name).toLowerCase();
      return (
        !entry.isDirectory() &&
        (fixedFormats.has(ext.slice(1)) || extensions.has(ext)) &&
        isIntakeCompanion(file, entry.name)
      );
    })
  ) {
    throw new Error("A subtitle appeared after subtitle intake.");
  }
}
