import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";

// config.ts and scanner.ts read these at import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-yt-notes-"));
process.env.CONFIG_DIR = path.join(root, "config");
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
const NOTES = path.join(root, "vault");
const PL = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";
const VIDEO = "iSn77jvjojA";
const FOLDER = "AI [talks]";
const BASE = `Short talk [${VIDEO}]`;
const MEDIA_FOLDER = path.join(root, "media", "YouTube", FOLDER);

const { createTask, setSetting } = await import("../config.js");
const { savePlaylist, defaultPlaylistFields, removePlaylist } = await import("./playlists.js");
const { YoutubeStore } = await import("./store.js");
const { YoutubeWorker } = await import("./worker.js");
const { registerYoutubeRoutes } = await import("../routes/youtube.js");
const { exportNoteForVideo, NoteExportError, writeFileAtomic } = await import("./note-export.js");

const webhookBodies: unknown[] = [];
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    webhookBodies.push(JSON.parse(body));
    res.end("ok");
  });
});
hook.listen(0, "127.0.0.1");
await once(hook, "listening");
after(() => hook.close());

const { lastInsertRowid: chineseTask } = createTask({ source_lang: "Automatic", target_lang: "繁體中文", output_pattern: "{{name}}.{{lang_code}}.srt", lang_code: "zh-TW" });
savePlaylist({ id: PL, title: "AI | Talks", ...defaultPlaylistFields(FOLDER), subtitleTaskIds: [chineseTask] });
setSetting("youtube_notes_dir", NOTES);
setSetting("notify_webhook_url", `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`);
setSetting("notify_events", "youtube:note");
setSetting("notify_format", "json");

const ENGLISH = `1
00:00:00,000 --> 00:00:04,000
Hello and welcome.

2
00:00:04,000 --> 00:00:50,000
This talk is about notes.

3
00:00:50,000 --> 00:00:55,000
Thanks for watching.
`;

const CHINESE = `1
00:00:00,000 --> 00:00:04,000
大家好，歡迎。

2
00:00:04,000 --> 00:00:50,000
這場演講談筆記。

3
00:00:50,000 --> 00:00:55,000
感謝收看。
`;

const INFO = {
  id: VIDEO,
  title: "Short talk",
  channel: "Richard",
  upload_date: "20260915",
  duration: 45,
  language: "en",
  description: "A short talk.",
  subtitles: { en: [{ ext: "vtt" }] },
};

const store = new YoutubeStore(new Database(":memory:"));
const announced: [string, Record<string, unknown>][] = [];
const deps = { store, announce: (event: string, data: Record<string, unknown>) => announced.push([event, data]) };

function seedDownloadedVideo() {
  fs.rmSync(MEDIA_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(MEDIA_FOLDER, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_FOLDER, `${BASE}.m4a`), "audio");
  fs.writeFileSync(path.join(MEDIA_FOLDER, `${BASE}.info.json`), JSON.stringify(INFO));
  fs.writeFileSync(path.join(MEDIA_FOLDER, `${BASE}.en.srt`), ENGLISH);
  fs.writeFileSync(path.join(MEDIA_FOLDER, `${BASE}.zh-TW.srt`), CHINESE);
  const now = "2026-10-01T00:00:00.000Z";
  store.applyListing(PL, [{ videoId: VIDEO, title: "Short talk", channel: "Richard", durationS: 45, publishedAt: null, position: 1, initial: { status: "queued" } }], { complete: false, now });
  const video = store.getVideo(VIDEO)!;
  if (video.status === "queued") {
    store.setStatus(VIDEO, "downloading", { now });
    store.setStatus(VIDEO, "transcribing", { now, mediaPath: `YouTube/${FOLDER}/${BASE}.m4a` });
  }
}

beforeEach(() => {
  fs.rmSync(NOTES, { recursive: true, force: true });
  fs.mkdirSync(NOTES, { recursive: true });
  seedDownloadedVideo();
  announced.length = 0;
  webhookBodies.length = 0;
});

const NOTE_FILE = path.join(NOTES, "AI talks", `Short talk (${VIDEO}).md`);
const PAYLOAD = {
  videoId: VIDEO,
  title: "Short talk",
  channel: "Richard",
  url: `https://www.youtube.com/watch?v=${VIDEO}`,
  playlistId: PL,
  notePath: `AI talks/Short talk (${VIDEO}).md`,
  translations: ["chi"],
};

test("export writes the note into the playlist's notes folder with one section per language", async () => {
  const result = await exportNoteForVideo(deps, VIDEO);
  assert.equal(result.file, NOTE_FILE);
  assert.equal(
    fs.readFileSync(NOTE_FILE, "utf8"),
    `---
title: "Short talk"
video_id: ${VIDEO}
url: https://www.youtube.com/watch?v=${VIDEO}
channel: "[[Richard]]"
published: 2026-09-15
duration: "00:45"
playlist: "[[AI Talks]]"
language: en
transcript_source: youtube_captions
translations: ["chi"]
tags: [youtube]
subsmelt_schema: 1
---

# Short talk

![](https://www.youtube.com/watch?v=${VIDEO})

> [!info]- Description
> A short talk.

## Transcript

[00:00](https://youtu.be/${VIDEO}?t=0) Hello and welcome. This talk is about notes.

[00:50](https://youtu.be/${VIDEO}?t=50) Thanks for watching.

## Transcript (繁體中文)

[00:00](https://youtu.be/${VIDEO}?t=0) 大家好，歡迎。這場演講談筆記。

[00:50](https://youtu.be/${VIDEO}?t=50) 感謝收看。
`,
  );
  assert.equal(store.getVideo(VIDEO)!.note_path, NOTE_FILE);
});

test("the note announces itself over SSE and the webhook with the documented payload", async () => {
  await exportNoteForVideo(deps, VIDEO);
  assert.deepEqual(announced, [["youtube:note", PAYLOAD]]);
  assert.equal(webhookBodies.length, 1);
  const { timestamp, ...body } = webhookBodies[0] as Record<string, unknown>;
  assert.match(String(timestamp), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body, { event: "youtube:note", ...PAYLOAD, message: "📝 Note ready: Short talk" });
});

test("a re-export overwrites the note and leaves no temp file behind", async () => {
  await exportNoteForVideo(deps, VIDEO);
  fs.writeFileSync(path.join(MEDIA_FOLDER, `${BASE}.zh-TW.srt`), CHINESE.replace("感謝收看。", "謝謝觀看。"));
  await exportNoteForVideo(deps, VIDEO);
  const note = fs.readFileSync(NOTE_FILE, "utf8");
  assert.match(note, /謝謝觀看。/);
  assert.doesNotMatch(note, /感謝收看/);
  assert.deepEqual(fs.readdirSync(path.dirname(NOTE_FILE)), [`Short talk (${VIDEO}).md`]);
});

test("a renamed video moves its note instead of leaving the old one", async () => {
  await exportNoteForVideo(deps, VIDEO);
  fs.writeFileSync(path.join(MEDIA_FOLDER, `${BASE}.info.json`), JSON.stringify({ ...INFO, title: "Short talk #2" }));
  await exportNoteForVideo(deps, VIDEO);
  assert.deepEqual(fs.readdirSync(path.dirname(NOTE_FILE)), [`Short talk 2 (${VIDEO}).md`]);
});

test("a translation identical to the transcript gets no second section", async () => {
  fs.writeFileSync(path.join(MEDIA_FOLDER, `${BASE}.zh-TW.srt`), ENGLISH);
  const result = await exportNoteForVideo(deps, VIDEO);
  assert.deepEqual(result.translations, []);
  assert.doesNotMatch(fs.readFileSync(NOTE_FILE, "utf8"), /## Transcript \(/);
});

test("a missing notes folder is reported and never created", async () => {
  fs.rmSync(NOTES, { recursive: true, force: true });
  await assert.rejects(exportNoteForVideo(deps, VIDEO), (error: unknown) => {
    assert.ok(error instanceof NoteExportError);
    assert.equal(error.kind, "notes_folder");
    assert.equal(error.message, `Notes folder ${NOTES} is not mounted`);
    return true;
  });
  assert.equal(fs.existsSync(NOTES), false);
  assert.deepEqual(announced, []);
});

test("a video with no subtitle beside its media is refused", async () => {
  fs.rmSync(path.join(MEDIA_FOLDER, `${BASE}.en.srt`));
  fs.rmSync(path.join(MEDIA_FOLDER, `${BASE}.zh-TW.srt`));
  await assert.rejects(exportNoteForVideo(deps, VIDEO), { name: "NoteExportError", message: `No subtitle found beside YouTube/${FOLDER}/${BASE}.m4a` });
});

test("an atomic write replaces the file whole and cleans up when the rename fails", () => {
  const dir = fs.mkdtempSync(path.join(root, "atomic-"));
  const file = path.join(dir, "note.md");
  fs.writeFileSync(file, "old");
  writeFileAtomic(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  const blocked = path.join(dir, "blocked.md");
  fs.mkdirSync(path.join(blocked, "child"), { recursive: true });
  assert.throws(() => writeFileAtomic(blocked, "x"));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["blocked.md", "note.md"]);
});

test("POST /api/youtube/videos/:id/note re-exports the note and maps failures to statuses", async () => {
  const app = express();
  app.use(express.json());
  const worker = new YoutubeWorker(store);
  worker.stop();
  registerYoutubeRoutes(app, store, worker);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (id: string) => {
    const res = await fetch(`${base}/api/youtube/videos/${id}/note`, { method: "POST" });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.deepEqual(await post(VIDEO), { status: 200, body: PAYLOAD });
    assert.ok(fs.existsSync(NOTE_FILE));
    assert.deepEqual(await post("aaaaaaaaaaa"), { status: 404, body: { error: "Unknown video" } });
    fs.rmSync(NOTES, { recursive: true, force: true });
    assert.deepEqual(await post(VIDEO), { status: 503, body: { error: `Notes folder ${NOTES} is not mounted` } });
    const folder = await fetch(`${base}/api/youtube/notes-folder?path=${encodeURIComponent(MEDIA_FOLDER)}`);
    assert.deepEqual(await folder.json(), { path: MEDIA_FOLDER, exists: true, writable: true });
  } finally {
    server.close();
  }
});

const JAPANESE_ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:04.00,Default,,0,0,0,,{\\i1}こんにちは、{\\i0}ようこそ。
Dialogue: 0,0:00:04.00,0:00:50.00,Default,,0,0,0,,この講演は\\Nノートの話です。
Dialogue: 0,0:00:50.00,0:00:55.00,Default,,0,0,0,,ご視聴ありがとう。
`;

test("an ASS translation is read by its format and gets its own section", async (t) => {
  const { lastInsertRowid: japaneseTask } = createTask({ source_lang: "Automatic", target_lang: "日本語", output_pattern: "{{name}}.ja.ass", lang_code: "ja" });
  savePlaylist({ id: PL, title: "AI | Talks", ...defaultPlaylistFields(FOLDER), subtitleTaskIds: [chineseTask, japaneseTask] });
  t.after(() => savePlaylist({ id: PL, title: "AI | Talks", ...defaultPlaylistFields(FOLDER), subtitleTaskIds: [chineseTask] }));
  fs.writeFileSync(path.join(MEDIA_FOLDER, `${BASE}.ja.ass`), JAPANESE_ASS);

  const result = await exportNoteForVideo(deps, VIDEO);

  assert.deepEqual(result.translations, ["chi", "jpn"]);
  const note = fs.readFileSync(NOTE_FILE, "utf8");
  assert.equal(note.slice(note.indexOf("## Transcript (日本語)")), `## Transcript (日本語)

[00:00](https://youtu.be/${VIDEO}?t=0) こんにちは、ようこそ。この講演はノートの話です。

[00:50](https://youtu.be/${VIDEO}?t=50) ご視聴ありがとう。
`);
});

function planRoutesTo(t: { after: (fn: () => void) => void }, taskIds: number[]) {
  const now = "2026-10-01T00:00:00.000Z";
  store.setStatus(VIDEO, "transcribing", { now, subtitlePlan: { spoken: "en", routes: taskIds.map((taskId) => ({ taskId, kind: "translate" as const })) } });
  t.after(() => {
    store.setStatus(VIDEO, "transcribing", { now, subtitlePlan: null });
    savePlaylist({ id: PL, title: "AI | Talks", ...defaultPlaylistFields(FOLDER), subtitleTaskIds: [chineseTask] });
  });
}

test("a task taken off the playlist mid-run still gets its section from the video's plan", async (t) => {
  planRoutesTo(t, [Number(chineseTask)]);
  savePlaylist({ id: PL, title: "AI | Talks", ...defaultPlaylistFields(FOLDER), subtitleTaskIds: [] });

  const result = await exportNoteForVideo(deps, VIDEO);

  assert.deepEqual(result.translations, ["chi"]);
  assert.match(fs.readFileSync(NOTE_FILE, "utf8"), /## Transcript \(繁體中文\)/);
});

test("an unfollowed playlist's video still exports into its folder with the planned translations", async (t) => {
  planRoutesTo(t, [Number(chineseTask)]);
  removePlaylist(PL);

  const result = await exportNoteForVideo(deps, VIDEO);

  assert.equal(result.file, NOTE_FILE);
  assert.deepEqual(result.translations, ["chi"]);
  assert.match(fs.readFileSync(NOTE_FILE, "utf8"), /## Transcript \(繁體中文\)/);
});
