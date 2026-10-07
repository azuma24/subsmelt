/** One subtitle cue, times in seconds. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface Chapter {
  start: number;
  title: string;
}

/** What the note says about the video, gathered from the info JSON, the video row and the playlist. */
export interface NoteInfo {
  videoId: string;
  title: string;
  channel: string | null;
  /** YYYY-MM-DD */
  published: string | null;
  /** YYYY-MM-DD, known only with a YouTube Data API key. */
  added: string | null;
  durationS: number | null;
  playlist: string | null;
  /** The spoken language of the transcript. */
  language: string | null;
  /** "youtube_captions" or "whisper:<model>". */
  transcriptSource: string | null;
  description: string | null;
  chapters: Chapter[];
}

export interface NoteTranslation {
  /** The section heading, as the user named the language in the task. */
  label: string;
  langCode: string;
  cues: Cue[];
}

export const NOTE_SCHEMA = 1;
const PARAGRAPH_MIN_S = 45;
// Captions without punctuation never end a sentence; this keeps them from becoming one wall of text.
const PARAGRAPH_MAX_S = 90;
const FILE_TITLE_MAX_BYTES = 180;
const SENTENCE_END_RE = /[.!?。！？…](?:["'”’)\]」』）]*)$/u;
// Obsidian breaks links on [ ] # ^ |; the rest are refused by some filesystem or read as a path.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a file name must not contain
const UNSAFE_NAME_RE = /[[\]#^|\\/:*?"<>\u0000-\u001f]/g;
const CJK_RE = /[　-鿿가-힯豈-﫿＀-￯]/u;

/** Keeps "#word" in a title or transcript from becoming an Obsidian tag. */
const escapeTags = (text: string) => text.replace(/(^|\s)#/g, "$1\\#");

/** A name safe as an Obsidian note name or inside `[[ ]]`. */
export function safeNoteName(name: string): string {
  return name
    .replace(UNSAFE_NAME_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
}

function truncateBytes(text: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    out += char;
  }
  return out.trimEnd();
}

/** `<title> (<id>).md`, with the title made safe and short enough for any filesystem. */
export function noteFileName(title: string, videoId: string): string {
  const safe = truncateBytes(safeNoteName(title), FILE_TITLE_MAX_BYTES);
  return safe ? `${safe} (${videoId}).md` : `${videoId}.md`;
}

/** 83 → "01:23"; 3723 → "1:02:03". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

const timestampLink = (videoId: string, seconds: number) =>
  `[${clock(seconds)}](https://youtu.be/${videoId}?t=${Math.max(0, Math.floor(seconds))})`;

/** Joins cue texts with a space, except between two CJK characters. */
function joinTexts(texts: string[]): string {
  let out = "";
  for (const text of texts) {
    if (!text) continue;
    const glue = out && !(CJK_RE.test(out.slice(-1)) && CJK_RE.test(text[0])) ? " " : "";
    out += glue + text;
  }
  return out;
}

function cleanCueText(text: string): string {
  const lines = text
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .split(/\r?\n/);
  return joinTexts(lines.map((line) => line.replace(/\s+/g, " ").trim()));
}

/**
 * Where each paragraph of the transcript starts: at a chapter start, or
 * after the first sentence end once 45 seconds have passed.
 */
export function paragraphStarts(cues: Cue[], chapters: Chapter[]): number[] {
  const chapterStarts = chapters.map((c) => c.start);
  const starts: number[] = [];
  let open: number | null = null;
  let closed = false;
  for (const cue of cues) {
    const chapterBreak = open !== null && chapterStarts.some((c) => c > open! && c <= cue.start);
    if (open === null || closed || chapterBreak) {
      open = cue.start;
      closed = false;
      starts.push(open);
    }
    const elapsed = cue.end - open;
    closed = (elapsed >= PARAGRAPH_MIN_S && SENTENCE_END_RE.test(cleanCueText(cue.text))) || elapsed >= PARAGRAPH_MAX_S;
  }
  return starts;
}

/** Groups cues into paragraphs that begin at `starts`, so a translation breaks where its source does. */
export function groupParagraphs(cues: Cue[], starts: number[]): { start: number; text: string }[] {
  const paragraphs: { start: number; texts: string[] }[] = [];
  let next = 0;
  for (const cue of cues) {
    let boundary = false;
    while (next < starts.length && cue.start >= starts[next]) {
      next += 1;
      boundary = true;
    }
    if (boundary || paragraphs.length === 0) paragraphs.push({ start: cue.start, texts: [] });
    paragraphs[paragraphs.length - 1].texts.push(cleanCueText(cue.text));
  }
  return paragraphs.map((p) => ({ start: p.start, text: escapeTags(joinTexts(p.texts)) })).filter((p) => p.text);
}

const yamlString = (value: string) => JSON.stringify(value);
// Quote every list value: PLAIN_YAML_RE values like "no" and "on" are YAML 1.1
// booleans (Norwegian!), so an unquoted `translations: [no, on]` would read as
// [false, true] in Obsidian.
const yamlList = (values: string[]) => `[${values.map((v) => yamlString(v)).join(", ")}]`;

function frontmatter(info: NoteInfo, translations: NoteTranslation[]): string {
  const lines: [string, string | null][] = [
    ["title", yamlString(info.title)],
    ["video_id", info.videoId],
    ["url", `https://www.youtube.com/watch?v=${info.videoId}`],
    ["channel", info.channel ? yamlString(`[[${safeNoteName(info.channel)}]]`) : null],
    ["published", info.published],
    ["added", info.added],
    ["duration", info.durationS !== null ? yamlString(clock(info.durationS)) : null],
    ["playlist", info.playlist ? yamlString(`[[${safeNoteName(info.playlist)}]]`) : null],
    ["language", info.language],
    ["transcript_source", info.transcriptSource],
    ["translations", yamlList(translations.map((t) => t.langCode))],
    ["tags", "[youtube]"],
    ["subsmelt_schema", String(NOTE_SCHEMA)],
  ];
  const body = lines.filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}: ${v}`);
  return ["---", ...body, "---"].join("\n");
}

function transcriptSection(heading: string, videoId: string, cues: Cue[], starts: number[]): string {
  const paragraphs = groupParagraphs(cues, starts).map((p) => `${timestampLink(videoId, p.start)} ${p.text}`);
  return [`## ${heading}`, ...paragraphs].join("\n\n");
}

/** The whole note for one video: frontmatter, description, chapters, the transcript and one section per translation. */
export function renderNote(info: NoteInfo, cues: Cue[], translations: NoteTranslation[]): string {
  const blocks = [
    frontmatter(info, translations),
    `# ${escapeTags(info.title)}`,
    `![](https://www.youtube.com/watch?v=${info.videoId})`,
  ];
  const description = info.description?.trim();
  if (description) {
    const quoted = description.split(/\r?\n/).map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"));
    blocks.push(["> [!info]- Description", ...quoted].join("\n"));
  }
  if (info.chapters.length) {
    blocks.push(
      [
        "## Chapters",
        ...info.chapters.map((c) => `- ${timestampLink(info.videoId, c.start)} ${escapeTags(c.title)}`),
      ].join("\n"),
    );
  }
  const starts = paragraphStarts(cues, info.chapters);
  blocks.push(transcriptSection("Transcript", info.videoId, cues, starts));
  for (const translation of translations) {
    blocks.push(transcriptSection(`Transcript (${translation.label})`, info.videoId, translation.cues, starts));
  }
  return `${blocks.join("\n\n")}\n`;
}
