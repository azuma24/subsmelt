import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MEDIA_DIR } from "../scanner.js";
import { assertMediaPathAllowed } from "../transcription-client.js";
import { inspectSubtitle, visibleCueText } from "../translator/subtitle-quality.js";
import { normalizeTimeToMs } from "../translator/convert.js";
import { readSubtitleFileText } from "../translator/encoding.js";
import { shareFile } from "../shared-files.js";
import { clock, groupParagraphs, paragraphStarts } from "../youtube/note.js";
import { MAX_REVIEW_BYTES, type WorkPlan } from "./work-plan.js";

const TIMED_FORMATS = new Set(["srt", "vtt", "ass", "ssa"]);
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export function readWorkArtifact(outputPath: string, limit = MAX_ARTIFACT_BYTES) {
  const file = assertMediaPathAllowed(outputPath, MEDIA_DIR);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error("Transcript is unavailable or exceeds the size limit");
  const ext = path.extname(outputPath).slice(1).toLowerCase();
  if (!TIMED_FORMATS.has(ext) && ext !== "txt") throw new Error("Unsupported transcript format");
  const content = readSubtitleFileText(file);
  const revision = createHash("sha256").update(content).digest("hex");
  return { file, content, ext, revision };
}

export function readReview(outputPath: string, quality?: WorkPlan["quality"]) {
  const { content, ext, revision } = readWorkArtifact(outputPath, MAX_REVIEW_BYTES);
  if (!TIMED_FORMATS.has(ext)) throw new Error("Source review requires a timed transcript");
  return { content, ext, revision, issues: inspectSubtitle(content, ext, quality).issues };
}

export function reviseTranscript(outputPath: string, revision: string, updated: unknown): string {
  const current = readWorkArtifact(outputPath, MAX_REVIEW_BYTES);
  if (current.revision !== revision) throw new Error("The source transcript changed. Reload it before approving.");
  if (updated === undefined || updated === current.content) return current.revision;
  if (typeof updated !== "string" || Buffer.byteLength(updated) > MAX_REVIEW_BYTES) {
    throw new Error("Invalid revised transcript");
  }
  const { cues, issues } = inspectSubtitle(updated, current.ext);
  if (!cues.some((cue) => cue.data?.text?.trim()) || issues.some((issue) => issue.code === "invalidTiming")) {
    throw new Error("The revised transcript needs valid cues and timestamps");
  }
  const tmp = fs.mkdtempSync(path.join(path.dirname(current.file), ".subsmelt-review-"));
  try {
    const staged = path.join(tmp, "subtitle");
    fs.writeFileSync(staged, updated, { mode: fs.statSync(current.file).mode & 0o777 });
    fs.renameSync(staged, current.file);
    shareFile(current.file);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return createHash("sha256").update(updated).digest("hex");
}

export function transcriptNote(title: string, content: string, ext: string): string {
  const heading = title.replace(/[\r\n]/g, " ");
  if (!TIMED_FORMATS.has(ext)) return `# ${heading}\n\n${content.trim()}\n`;
  const { cues } = inspectSubtitle(content, ext);
  const entries = cues.map(({ data }) => ({
    start: normalizeTimeToMs(data?.start) / 1000,
    end: normalizeTimeToMs(data?.end) / 1000,
    text: visibleCueText(data?.text ?? "", ext),
  }));
  const paragraphs = groupParagraphs(entries, paragraphStarts(entries, []));
  return `# ${heading}\n\n${paragraphs.map(({ start, text }) => `**${clock(start)}** ${text}`).join("\n\n")}\n`;
}
