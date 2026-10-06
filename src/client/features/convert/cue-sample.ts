/**
 * Extract a plain-text sample of subtitle dialogue for language detection.
 * Handles SRT/VTT blocks and ASS/SSA Dialogue lines; strips timestamps, cue
 * indices, cue settings, inline tags and override codes so only spoken text
 * feeds the detector. Pure — no DOM, no parser dependency.
 */

const DEFAULT_MAX_CUES = 30;

const SRT_VTT_TIMING = /-->/;
const VTT_HEADER = /^WEBVTT/;
const NUMERIC_INDEX = /^\d+$/;
const ASS_DIALOGUE = /^Dialogue:\s*/i;
const ASS_SECTION_OR_META = /^(\[|Format:|Style:|Comment:|Title:|ScriptType:|PlayRes|WrapStyle|Collisions)/i;
const HTML_LIKE_TAGS = /<[^>]*>/g;
const ASS_OVERRIDE_TAGS = /\{[^}]*\}/g;

function cleanLine(line: string): string {
  return line
    .replace(HTML_LIKE_TAGS, "")
    .replace(ASS_OVERRIDE_TAGS, "")
    .replace(/\\N|\\n|\\h/g, " ")
    .trim();
}

function assDialogueText(line: string): string {
  // Text is the 10th comma-separated field; text itself may contain commas.
  const parts = line.replace(ASS_DIALOGUE, "").split(",");
  return parts.slice(9).join(",");
}

export function sampleCueText(content: string, maxCues: number = DEFAULT_MAX_CUES): string {
  const lines = content.split(/\r?\n/);
  const cues: string[] = [];
  let currentCue: string[] = [];
  let inNote = false;

  const flush = () => {
    if (currentCue.length > 0) {
      cues.push(currentCue.join(" "));
      currentCue = [];
    }
  };

  for (const raw of lines) {
    if (cues.length >= maxCues) break;
    const line = raw.trim();

    if (ASS_DIALOGUE.test(line)) {
      const text = cleanLine(assDialogueText(line));
      if (text) cues.push(text);
      continue;
    }
    if (ASS_SECTION_OR_META.test(line)) continue;

    if (!line) {
      inNote = false;
      flush();
      continue;
    }
    if (VTT_HEADER.test(line)) continue;
    if (line.startsWith("NOTE")) {
      inNote = true;
      continue;
    }
    if (inNote) continue;
    if (SRT_VTT_TIMING.test(line)) continue; // timing row (cue settings live on it too)
    if (NUMERIC_INDEX.test(line)) continue;

    const text = cleanLine(line);
    if (text) currentCue.push(text);
  }
  flush();

  return cues.slice(0, maxCues).join("\n");
}
