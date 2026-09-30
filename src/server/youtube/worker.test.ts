import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-yt-worker-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = path.join(root, "media");
process.env.SUBSMELT_YTDLP_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-yt-dlp.mjs");

const { savePlaylist, writePlaylists } = await import("./playlists.js");
const { YoutubeStore } = await import("./store.js");
const { CooldownError, YoutubeWorker, youtubeTmpRoot } = await import("./worker.js");
type YoutubePlaylist = import("./playlists.js").YoutubePlaylist;
type Store = InstanceType<typeof YoutubeStore>;

const PL = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";
const VID = "qD0_yWgifDM";
const T0 = "2026-09-30T10:00:00.000Z";
const DEST = path.join(root, "media", "YouTube", "AI");
const ARGV = path.join(root, "argv.jsonl");
const FAKE_KEYS = ["FAKE_YTDLP_STDOUT", "FAKE_YTDLP_STDERR", "FAKE_YTDLP_EXIT", "FAKE_YTDLP_FAIL_WHEN_ARG", "FAKE_YTDLP_SLEEP_MS", "FAKE_YTDLP_TITLE", "FAKE_YTDLP_INFO"];

const progress = (downloaded: number, filename = "part.m4a") =>
  `[subsmelt-progress] ${JSON.stringify({ status: "downloading", downloaded_bytes: downloaded, total_bytes: 1000, filename })}\n`;

function playlist(overrides: Partial<YoutubePlaylist> = {}): YoutubePlaylist {
  return {
    id: PL,
    title: "AI",
    folder: "AI",
    enabled: true,
    mode: "auto",
    backfill: { kind: "none" },
    media: { type: "audio", format: "m4a" },
    captions: "prefer_youtube",
    subtitleTaskIds: [],
    checkEveryMinutes: 60,
    ...overrides,
  };
}

interface Rig {
  store: Store;
  events: [string, Record<string, unknown>][];
  clock: { now: Date };
  worker: InstanceType<typeof YoutubeWorker>;
  restart: () => InstanceType<typeof YoutubeWorker>;
}

/** A followed playlist with one video in `status`, fake yt-dlp settings from `fake`, and a clock the test moves. */
function rig(t: { after: (fn: () => void) => void }, fake: Record<string, string> = {}, options: { status?: "queued" | "new"; playlist?: Partial<YoutubePlaylist> } = {}): Rig {
  fs.rmSync(path.join(root, "media"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "data", "youtube"), { recursive: true, force: true });
  fs.rmSync(ARGV, { force: true });
  for (const key of FAKE_KEYS) delete process.env[key];
  Object.assign(process.env, { FAKE_YTDLP_ARGV_FILE: ARGV, FAKE_YTDLP_TITLE: "TED-Ed lesson", ...fake });
  t.after(() => {
    for (const key of FAKE_KEYS) delete process.env[key];
    writePlaylists([]);
  });

  savePlaylist(playlist(options.playlist));
  const store = new YoutubeStore(new Database(":memory:"));
  store.applyListing(PL, [{
    videoId: VID, title: "How to spot a fake", channel: "TED-Ed", durationS: 234, publishedAt: "2023-10-01", position: 1,
    initial: { status: options.status ?? "queued" },
  }], { complete: true, now: T0 });
  const events: Rig["events"] = [];
  const clock = { now: new Date(T0) };
  const make = () => new YoutubeWorker(store, { now: () => clock.now, announce: (event, data) => events.push([event, data]) });
  return { store, events, clock, worker: make(), restart: make };
}

const ytdlpRuns = (): string[][] => (fs.existsSync(ARGV) ? fs.readFileSync(ARGV, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const sortArgs = () => ytdlpRuns().map((args) => args[args.indexOf("-S") + 1]);
const row = (store: Store) => {
  const v = store.getVideo(VID)!;
  return { status: v.status, attempts: v.attempts, reason: v.reason, retry_after: v.retry_after, media_path: v.media_path, skip_kind: v.skip_kind };
};
const leftovers = () => (fs.existsSync(youtubeTmpRoot()) ? fs.readdirSync(youtubeTmpRoot(), { recursive: true }) : []);
const later = (clock: { now: Date }, iso: string) => { clock.now = new Date(iso); };
const DOWNLOADED = { status: "transcribing", attempts: 0, reason: null, retry_after: null, media_path: `YouTube/AI/TED-Ed lesson [${VID}].m4a`, skip_kind: null };

test("a queued video downloads into the playlist folder with progress, a cookie copy, and no scratch files left", async (t) => {
  const { store, events, worker } = rig(t, {
    FAKE_YTDLP_STDOUT: `[download] Destination: x\n${progress(250)}${progress(260)}${progress(500)}${progress(1000)}`,
    FAKE_YTDLP_INFO: JSON.stringify({ title: "How to spot a fake, exactly", channel: "TED-Ed", upload_date: "20231015", duration: 234.4, cookies: "SID=x; Domain=.youtube.com" }),
  });
  fs.mkdirSync(path.join(root, "data", "youtube"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "youtube", "cookies.txt"), ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n");

  await worker.drain();

  assert.deepEqual(row(store), DOWNLOADED);
  assert.deepEqual(fs.readdirSync(DEST).sort(), [`TED-Ed lesson [${VID}].info.json`, `TED-Ed lesson [${VID}].m4a`]);
  const info = JSON.parse(fs.readFileSync(path.join(DEST, `TED-Ed lesson [${VID}].info.json`), "utf8"));
  assert.deepEqual(Object.keys(info).sort(), ["channel", "duration", "id", "title", "upload_date"]);
  const video = store.getVideo(VID)!;
  assert.deepEqual([video.title, video.published_at, video.duration_s], ["How to spot a fake, exactly", "2023-10-15", 234]);

  const [args] = ytdlpRuns();
  assert.equal(args[args.indexOf("--cookies") + 1], path.join(root, "data", "youtube", "tmp", VID, "cookies.txt"));
  assert.equal(args[args.length - 1], `https://www.youtube.com/watch?v=${VID}`);
  assert.deepEqual(leftovers(), []);
  assert.deepEqual(events, [
    ["youtube:video", { videoId: VID, playlistId: PL, status: "downloading" }],
    ["youtube:video", { videoId: VID, playlistId: PL, status: "downloading", pct: 25 }],
    ["youtube:video", { videoId: VID, playlistId: PL, status: "downloading", pct: 50 }],
    ["youtube:video", { videoId: VID, playlistId: PL, status: "downloading", pct: 99 }],
    ["youtube:video", { videoId: VID, playlistId: PL, status: "transcribing" }],
  ]);
});

test("HTTP 429 queues the video again and pauses the lane for an hour, then two", async (t) => {
  const tooMany = "ERROR: unable to download video data: HTTP Error 429: Too Many Requests\n";
  const { store, events, clock, worker } = rig(t, { FAKE_YTDLP_STDERR: tooMany, FAKE_YTDLP_EXIT: "1" });

  await worker.drain();
  assert.deepEqual(row(store), { status: "queued", attempts: 0, reason: tooMany.trim(), retry_after: null, media_path: null, skip_kind: null });
  assert.deepEqual(events.at(-1), ["youtube:cooldown", { until: "2026-09-30T11:00:00.000Z", cause: "rate_limited" }]);

  later(clock, "2026-09-30T10:59:00.000Z");
  await worker.drain();
  await assert.rejects(worker.checkPlaylist(playlist()), CooldownError);
  assert.equal(ytdlpRuns().length, 1);

  later(clock, "2026-09-30T11:00:00.000Z");
  await worker.drain();
  assert.equal(ytdlpRuns().length, 2);
  assert.deepEqual(worker.activeCooldown(), { until: "2026-09-30T13:00:00.000Z", cause: "rate_limited", strikes: 2 });

  delete process.env.FAKE_YTDLP_STDERR;
  delete process.env.FAKE_YTDLP_EXIT;
  later(clock, "2026-09-30T13:00:00.000Z");
  await worker.drain();
  assert.equal(row(store).status, "transcribing");
  assert.equal(store.getCooldown(), null);
});

test("a bot check queues the video again under a cooldown that names the cause", async (t) => {
  const { store, worker } = rig(t, { FAKE_YTDLP_STDERR: `ERROR: [youtube] ${VID}: Sign in to confirm you’re not a bot. Use --cookies\n`, FAKE_YTDLP_EXIT: "1" });
  await worker.drain();
  assert.equal(row(store).status, "queued");
  assert.deepEqual(worker.activeCooldown(), { until: "2026-09-30T11:00:00.000Z", cause: "bot_check", strikes: 1 });
});

test("a premiere waits until the time YouTube gave, then downloads", async (t) => {
  const premiere = `ERROR: [youtube] ${VID}: Premieres in 5 hours\n`;
  const { store, clock, worker } = rig(t, { FAKE_YTDLP_STDERR: premiere, FAKE_YTDLP_EXIT: "1" });

  await worker.drain();
  assert.deepEqual(row(store), { status: "waiting", attempts: 0, reason: premiere.trim(), retry_after: "2026-09-30T15:00:00.000Z", media_path: null, skip_kind: null });

  delete process.env.FAKE_YTDLP_STDERR;
  delete process.env.FAKE_YTDLP_EXIT;
  later(clock, "2026-09-30T14:59:00.000Z");
  await worker.drain();
  assert.deepEqual([row(store).status, ytdlpRuns().length], ["waiting", 1]);
  later(clock, "2026-09-30T15:00:00.000Z");
  await worker.drain();
  assert.deepEqual([row(store).status, ytdlpRuns().length], ["transcribing", 2]);
});

test("a format error retries once without the codec preference", async (t) => {
  const { store, worker } = rig(t, {
    FAKE_YTDLP_STDERR: `ERROR: [youtube] ${VID}: Requested format is not available. Use --list-formats\n`,
    FAKE_YTDLP_EXIT: "1",
    FAKE_YTDLP_FAIL_WHEN_ARG: "vcodec:",
  }, { playlist: { media: { type: "video", maxHeight: 720, codec: "h264", container: "mp4" } } });

  await worker.drain();
  assert.deepEqual(row(store), { ...DOWNLOADED, media_path: `YouTube/AI/TED-Ed lesson [${VID}].mp4` });
  assert.deepEqual(sortArgs(), ["lang,res:720,vcodec:h264,acodec:aac", "lang,res:720"]);
});

test("a format error that survives the retry fails the video", async (t) => {
  const notAvailable = `ERROR: [youtube] ${VID}: Requested format is not available. Use --list-formats\n`;
  const { store, worker } = rig(t, { FAKE_YTDLP_STDERR: notAvailable, FAKE_YTDLP_EXIT: "1" });
  await worker.drain();
  assert.deepEqual(row(store), { status: "failed", attempts: 0, reason: notAvailable.trim(), retry_after: null, media_path: null, skip_kind: null });
  assert.deepEqual(sortArgs(), ["lang,acodec:m4a", "lang"]);
});

test("other failures back off 10 minutes, 1 hour, 6 hours, and the fourth fails the video", async (t) => {
  const broken = "ERROR: Postprocessing: Conversion failed!\n";
  const { store, clock, worker } = rig(t, { FAKE_YTDLP_STDERR: broken, FAKE_YTDLP_EXIT: "1" });
  const seen: [string, number, string | null][] = [];
  for (const at of [T0, "2026-09-30T10:10:00.000Z", "2026-09-30T11:10:00.000Z", "2026-09-30T17:10:00.000Z"]) {
    later(clock, at);
    await worker.drain();
    const { status, attempts, retry_after } = row(store);
    seen.push([status, attempts, retry_after]);
  }
  assert.deepEqual(seen, [
    ["queued", 1, "2026-09-30T10:10:00.000Z"],
    ["queued", 2, "2026-09-30T11:10:00.000Z"],
    ["queued", 3, "2026-09-30T17:10:00.000Z"],
    ["failed", 4, null],
  ]);
  assert.equal(row(store).reason, broken.trim());
});

test("private and members-only videos leave the lane with their own status", async (t) => {
  const cases: [string, [string, string | null]][] = [
    [`ERROR: [youtube] ${VID}: Private video. Sign in if you've been granted access to this video\n`, ["unavailable", null]],
    [`ERROR: [youtube] ${VID}: Join this channel to get access to members-only content like this video\n`, ["skipped", "members_only"]],
  ];
  for (const [stderr, expected] of cases) {
    const { store, worker } = rig(t, { FAKE_YTDLP_STDERR: stderr, FAKE_YTDLP_EXIT: "1" });
    await worker.drain();
    assert.deepEqual([row(store).status, row(store).skip_kind], expected);
  }
});

test("manual mode downloads nothing until the user asks for the video", async (t) => {
  const { store, worker } = rig(t, {}, { status: "new", playlist: { mode: "manual" } });
  await worker.drain();
  assert.deepEqual([row(store).status, ytdlpRuns().length], ["new", 0]);
  store.applyUserAction(VID, "download", T0);
  await worker.drain();
  assert.equal(row(store).status, "transcribing");
});

test("stopping mid-download leaves the row for the next boot, which downloads it again", async (t) => {
  const { store, worker, restart } = rig(t, { FAKE_YTDLP_SLEEP_MS: "10000" });
  const running = worker.drain();
  while (!fs.existsSync(path.join(youtubeTmpRoot(), VID, "part", `${VID}.part`))) await new Promise((r) => setTimeout(r, 10));
  worker.stop();
  await running;
  assert.equal(row(store).status, "downloading");

  delete process.env.FAKE_YTDLP_SLEEP_MS;
  const next = restart();
  assert.deepEqual(next.reconcile(), { requeued: 1, adopted: 0 });
  await next.drain();
  assert.deepEqual(row(store), DOWNLOADED);
  assert.deepEqual(leftovers(), []);
});

// What a crash leaves behind at each step of a download, as rows and files.
const CRASH_POINTS: { name: string; files: Record<string, string>; ytdlpRuns: number; reconciled: { requeued: number; adopted: number } }[] = [
  { name: "before yt-dlp started", files: {}, ytdlpRuns: 1, reconciled: { requeued: 1, adopted: 0 } },
  { name: "mid-download", files: { [`data/youtube/tmp/${VID}/part/${VID}.part`]: "partial", [`data/youtube/tmp/${VID}/cookies.txt`]: "jar" }, ytdlpRuns: 1, reconciled: { requeued: 1, adopted: 0 } },
  { name: "mid-move, info JSON moved but not the media", files: { [`media/YouTube/AI/TED-Ed lesson [${VID}].info.json`]: "{}" }, ytdlpRuns: 1, reconciled: { requeued: 1, adopted: 0 } },
  { name: "mid cross-filesystem copy of the media", files: { [`media/YouTube/AI/TED-Ed lesson [${VID}].info.json`]: "{}", [`media/YouTube/AI/TED-Ed lesson [${VID}].m4a.subsmelt-partial`]: "med" }, ytdlpRuns: 1, reconciled: { requeued: 1, adopted: 0 } },
  { name: "after the move, before the row was updated", files: { [`media/YouTube/AI/TED-Ed lesson [${VID}].info.json`]: JSON.stringify({ title: "How to spot a fake, exactly", upload_date: "20231015" }), [`media/YouTube/AI/TED-Ed lesson [${VID}].m4a`]: "media" }, ytdlpRuns: 0, reconciled: { requeued: 1, adopted: 1 } },
];

for (const point of CRASH_POINTS) {
  test(`a crash ${point.name} converges after restart, and reconciling again changes nothing`, async (t) => {
    const { store, restart } = rig(t);
    store.setStatus(VID, "downloading", { now: T0 });
    for (const [file, content] of Object.entries(point.files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }

    const worker = restart();
    assert.deepEqual(worker.reconcile(), point.reconciled);
    assert.deepEqual(leftovers(), []);
    await worker.drain();
    assert.deepEqual(worker.reconcile(), { requeued: 0, adopted: 0 });

    assert.deepEqual(row(store), DOWNLOADED);
    assert.deepEqual(fs.readdirSync(DEST).sort(), [`TED-Ed lesson [${VID}].info.json`, `TED-Ed lesson [${VID}].m4a`]);
    assert.equal(ytdlpRuns().length, point.ytdlpRuns);
    if (point.reconciled.adopted) assert.deepEqual([store.getVideo(VID)!.title, store.getVideo(VID)!.published_at], ["How to spot a fake, exactly", "2023-10-15"]);
  });
}
