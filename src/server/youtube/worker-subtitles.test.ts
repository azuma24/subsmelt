import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-yt-subs-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = path.join(root, "media");
process.env.SUBSMELT_YTDLP_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-yt-dlp.mjs");

const config = await import("../config.js");
const db = await import("../db.js");
const { savePlaylist, writePlaylists } = await import("./playlists.js");
const { YoutubeStore } = await import("./store.js");
const { YoutubeWorker, youtubeTmpRoot } = await import("./worker.js");
type Store = InstanceType<typeof YoutubeStore>;
type TranscribeRequest = import("./subtitles.js").TranscribeRequest;

const PL = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";
const VID = "iSn77jvjojA";
const T0 = "2026-10-01T10:00:00.000Z";
const DEST = path.join(root, "media", "YouTube", "AI");
const STEM = path.join(DEST, `Short talk [${VID}]`);
const ARGV = path.join(root, "argv.jsonl");
const FAKE_KEYS = ["FAKE_YTDLP_NO_SUBS", "FAKE_YTDLP_STDERR", "FAKE_YTDLP_EXIT", "FAKE_YTDLP_FAIL_WHEN_ARG"];
const CUE = (text: string) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;

for (const task of [...config.getTasks()]) config.deleteTask(task.id);
const task = (target_lang: string, lang_code: string) =>
  Number(config.createTask({ source_lang: "Automatic", target_lang, output_pattern: `{{name}}.${lang_code}.srt`, lang_code }).lastInsertRowid);
const ENG = task("English", "eng");
const CHT = task("Traditional Chinese", "cht");
const JPN = task("Japanese", "jpn");

interface Rig {
  store: Store;
  worker: InstanceType<typeof YoutubeWorker>;
  events: [string, Record<string, unknown>][];
  clock: { now: Date };
  queueStarts: string[];
  whisper: TranscribeRequest[];
}

/**
 * A playlist picking `taskIds`, one video just downloaded whose info JSON says
 * `info`, a fake Whisper that writes an SRT and reports `detected`, and a
 * translation queue that only records its starts.
 */
function rig(t: { after: (fn: () => void) => void }, opts: {
  taskIds: number[];
  info: Record<string, unknown>;
  captions?: "prefer_youtube" | "whisper_only";
  fake?: Record<string, string>;
  detected?: string | null;
  whisperFails?: string;
}): Rig {
  fs.rmSync(path.join(root, "media"), { recursive: true, force: true });
  fs.rmSync(ARGV, { force: true });
  db.default.prepare("DELETE FROM jobs").run();
  for (const key of FAKE_KEYS) delete process.env[key];
  Object.assign(process.env, { FAKE_YTDLP_ARGV_FILE: ARGV, ...opts.fake });
  t.after(() => {
    for (const key of FAKE_KEYS) delete process.env[key];
    writePlaylists([]);
  });
  savePlaylist({
    id: PL, title: "AI", folder: "AI", enabled: true, mode: "auto", backfill: { kind: "none" },
    media: { type: "audio", format: "m4a" }, captions: opts.captions ?? "prefer_youtube", subtitleTaskIds: opts.taskIds, checkEveryMinutes: 60,
  });
  const store = new YoutubeStore(new Database(":memory:"));
  store.applyListing(PL, [{ videoId: VID, title: "Short talk", channel: "AI", durationS: 45, publishedAt: "2026-09-30", position: 1, initial: { status: "queued" } }], { complete: true, now: T0 });
  const events: Rig["events"] = [];
  const clock = { now: new Date(T0) };
  const queueStarts: string[] = [];
  const whisper: TranscribeRequest[] = [];
  const worker = new YoutubeWorker(store, {
    now: () => clock.now,
    announce: (event, data) => events.push([event, data]),
    queue: { start: () => queueStarts.push("start"), startHeld: () => undefined, running: () => false },
    transcribe: async (req, onProgress) => {
      whisper.push(req);
      if (opts.whisperFails) throw new Error(opts.whisperFails);
      onProgress(50);
      const out = `${req.mediaPath.slice(0, -path.extname(req.mediaPath).length)}.srt`;
      fs.writeFileSync(out, CUE("whisper"));
      return { outputPath: out, language: opts.detected ?? null, model: "small" };
    },
  });
  // What the download step leaves: the media file and its info JSON in the playlist folder.
  fs.mkdirSync(DEST, { recursive: true });
  fs.writeFileSync(`${STEM}.m4a`, "media");
  fs.writeFileSync(`${STEM}.info.json`, JSON.stringify({ id: VID, title: "Short talk", ...opts.info }));
  store.setStatus(VID, "downloading", { now: T0 });
  store.setStatus(VID, "transcribing", { now: T0, mediaPath: `YouTube/AI/Short talk [${VID}].m4a` });
  return { store, worker, events, clock, queueStarts, whisper };
}

const captionRuns = () =>
  (fs.existsSync(ARGV) ? fs.readFileSync(ARGV, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [])
    .filter((args) => args.includes("--skip-download"))
    .map((args) => args[args.indexOf("--sub-langs") + 1]);
const filesOnDisk = () => Object.fromEntries(fs.readdirSync(DEST).filter((n) => n.endsWith(".srt")).sort().map((n) => [n, fs.readFileSync(path.join(DEST, n), "utf8")]));
const jobs = () => db.getJobs().map((j) => [j.task_id, path.basename(j.srt_path), path.basename(j.output_path), j.status]);
const plan = (store: Store) => JSON.parse(store.getVideo(VID)!.subtitle_plan ?? "null");
const row = (store: Store) => {
  const v = store.getVideo(VID)!;
  return { status: v.status, attempts: v.attempts, reason: v.reason, retry_after: v.retry_after, subtitle_path: v.subtitle_path };
};

test("creator captions give the transcript and one language, the same language is copied, and the rest becomes a translation job", async (t) => {
  const { store, worker, events, queueStarts, whisper } = rig(t, {
    taskIds: [ENG, CHT, JPN],
    info: { language: "en", subtitles: { en: [{}], "zh-Hant": [{}], live_chat: [{}] } },
  });

  await worker.drainSubtitles();

  assert.deepEqual(captionRuns(), ["^en$", "^zh-Hant$"]);
  assert.deepEqual(whisper, []);
  assert.deepEqual(filesOnDisk(), {
    "Short talk [iSn77jvjojA].cht.srt": CUE("caption zh-Hant"),
    "Short talk [iSn77jvjojA].en.srt": CUE("caption en"),
    "Short talk [iSn77jvjojA].eng.srt": CUE("caption en"),
  });
  assert.deepEqual(jobs(), [[JPN, "Short talk [iSn77jvjojA].en.srt", "Short talk [iSn77jvjojA].jpn.srt", "pending"]]);
  assert.deepEqual(queueStarts, ["start"]);
  assert.deepEqual(row(store), { status: "translating", attempts: 0, reason: null, retry_after: null, subtitle_path: "YouTube/AI/Short talk [iSn77jvjojA].en.srt" });
  assert.deepEqual(fs.existsSync(youtubeTmpRoot()) ? fs.readdirSync(youtubeTmpRoot()) : [], []);
  assert.deepEqual(plan(store), { spoken: "en", routes: [{ taskId: ENG, kind: "same" }, { taskId: CHT, kind: "captions" }, { taskId: JPN, kind: "translate" }] });
  assert.equal(store.getVideo(VID)!.transcript_source, "youtube_captions");

  worker.finishTranslated();
  assert.equal(store.getVideo(VID)!.status, "translating", "a pending translation keeps the video translating");

  db.updateJob(db.getJobs()[0].id, { status: "done" });
  worker.finishTranslated();
  assert.equal(store.getVideo(VID)!.status, "done");
  assert.deepEqual(events, [
    ["youtube:video", { videoId: VID, playlistId: PL, status: "translating" }],
    ["youtube:video", { videoId: VID, playlistId: PL, status: "done" }],
  ]);
});

test("without captions Whisper transcribes, its detected language names the transcript, and a video needing no translation finishes at once", async (t) => {
  const { store, worker, events, queueStarts, whisper } = rig(t, { taskIds: [JPN], info: {}, detected: "ja" });

  await worker.drainSubtitles();

  assert.deepEqual(whisper, [{ mediaPath: `${STEM}.m4a`, language: "auto", durationS: 45 }]);
  assert.deepEqual(filesOnDisk(), {
    "Short talk [iSn77jvjojA].ja.srt": CUE("whisper"),
    "Short talk [iSn77jvjojA].jpn.srt": CUE("whisper"),
  });
  assert.deepEqual([jobs(), queueStarts], [[], []]);
  assert.equal(store.getVideo(VID)!.status, "done");
  assert.deepEqual(events, [
    ["youtube:video", { videoId: VID, playlistId: PL, status: "transcribing", pct: 50 }],
    ["youtube:video", { videoId: VID, playlistId: PL, status: "translating" }],
    ["youtube:video", { videoId: VID, playlistId: PL, status: "done" }],
  ]);
});

test("Always transcribe ignores creator captions and tells Whisper the spoken language", async (t) => {
  const { worker, whisper } = rig(t, {
    taskIds: [CHT],
    captions: "whisper_only",
    info: { language: "zh-TW", subtitles: { "zh-TW": [{}] } },
  });

  await worker.drainSubtitles();

  assert.deepEqual(captionRuns(), []);
  assert.deepEqual(whisper.map((r) => r.language), ["zh"]);
  assert.deepEqual(Object.keys(filesOnDisk()), ["Short talk [iSn77jvjojA].cht.srt", "Short talk [iSn77jvjojA].zh-TW.srt"]);
});

test("a caption YouTube turns out not to have falls back to Whisper for the transcript and to a job for the language", async (t) => {
  const { store, worker, whisper } = rig(t, {
    taskIds: [CHT],
    info: { language: "en", subtitles: { en: [{}], "zh-Hant": [{}] } },
    fake: { FAKE_YTDLP_NO_SUBS: "en,zh-Hant" },
    detected: "en",
  });

  await worker.drainSubtitles();

  assert.deepEqual(captionRuns(), ["^en$", "^zh-Hant$"]);
  assert.deepEqual(whisper.map((r) => r.language), ["en"]);
  assert.deepEqual(jobs(), [[CHT, "Short talk [iSn77jvjojA].en.srt", "Short talk [iSn77jvjojA].cht.srt", "pending"]]);
  assert.deepEqual(plan(store), { spoken: "en", routes: [{ taskId: CHT, kind: "translate" }] });
  assert.equal(store.getVideo(VID)!.transcript_source, "whisper:small");
});

test("a 429 on a caption waits out the cooldown instead of falling back, and nothing is spent", async (t) => {
  const { store, worker, whisper } = rig(t, {
    taskIds: [ENG],
    info: { language: "en", subtitles: { en: [{}] } },
    fake: { FAKE_YTDLP_FAIL_WHEN_ARG: "--skip-download", FAKE_YTDLP_STDERR: "ERROR: HTTP Error 429: Too Many Requests\n", FAKE_YTDLP_EXIT: "1" },
  });

  await worker.drainSubtitles();

  assert.deepEqual(whisper, []);
  assert.deepEqual(row(store), { status: "transcribing", attempts: 0, reason: null, retry_after: null, subtitle_path: null });
  assert.equal(store.getCooldown()?.cause, "rate_limited");
});

test("a Whisper failure backs off, and the fourth one fails the video", async (t) => {
  const { store, worker, clock } = rig(t, { taskIds: [], info: {}, whisperFails: "Transcription backend returned HTTP 500" });

  await worker.drainSubtitles();
  assert.deepEqual(row(store), { status: "transcribing", attempts: 1, reason: "Transcription backend returned HTTP 500", retry_after: "2026-10-01T10:10:00.000Z", subtitle_path: null });

  for (const at of ["2026-10-01T10:10:00.000Z", "2026-10-01T11:10:00.000Z", "2026-10-01T17:10:00.000Z"]) {
    clock.now = new Date(at);
    await worker.drainSubtitles();
  }
  assert.deepEqual(row(store), { status: "failed", attempts: 4, reason: "Transcription backend returned HTTP 500", retry_after: null, subtitle_path: null });
});

test("a transcript and a language already on disk from a run that crashed are not fetched again", async (t) => {
  const { worker } = rig(t, { taskIds: [ENG, CHT, JPN], info: { language: "en", subtitles: { en: [{}], "zh-Hant": [{}] } } });
  fs.writeFileSync(`${STEM}.en.srt`, CUE("kept"));
  fs.writeFileSync(`${STEM}.cht.srt`, CUE("kept too"));

  await worker.drainSubtitles();

  assert.deepEqual(captionRuns(), []);
  assert.deepEqual(filesOnDisk(), {
    "Short talk [iSn77jvjojA].cht.srt": CUE("kept too"),
    "Short talk [iSn77jvjojA].en.srt": CUE("kept"),
    "Short talk [iSn77jvjojA].eng.srt": CUE("kept"),
  });
  assert.deepEqual(jobs(), [[JPN, "Short talk [iSn77jvjojA].en.srt", "Short talk [iSn77jvjojA].jpn.srt", "pending"]]);
});

test("the live Whisper path waits for a backend without touching the video", async (t) => {
  const { store } = rig(t, { taskIds: [], info: {} });
  const worker = new YoutubeWorker(store, { now: () => new Date(T0), announce: () => undefined, queue: { start: () => undefined, startHeld: () => undefined, running: () => false } });

  await worker.drainSubtitles();

  assert.deepEqual(row(store), { status: "transcribing", attempts: 0, reason: null, retry_after: null, subtitle_path: null });
  assert.equal(worker.whisperBacklog(), 0, "without a backend a transcribing video does not hold translation");
});
