import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-gpu-gate-"));
process.env.DATA_DIR = path.join(scratch, "data");
process.env.CONFIG_DIR = path.join(scratch, "config");
process.env.MEDIA_DIR = path.join(scratch, "media");
fs.mkdirSync(process.env.MEDIA_DIR);
const db = await import("./db.js");
const config = await import("./config.js");
const queue = await import("./queue.js");
const gate = await import("./gpu-gate.js");

const base = { shared: true, transcriptionsRunning: 0, youtubeBacklog: 0, subtitlesWaiting: 3 };

test("with its own GPU, translation never waits", () => {
  assert.deepEqual(gate.translationGate({ ...base, shared: false, transcriptionsRunning: 2, youtubeBacklog: 9 }), { open: true });
});

test("a shared GPU holds translation while videos still need Whisper", () => {
  assert.deepEqual(gate.translationGate({ ...base, youtubeBacklog: 3 }), { open: false, waitingFor: 3 });
  assert.deepEqual(gate.translationGate({ ...base, transcriptionsRunning: 1 }), { open: false, waitingFor: 1 });
  assert.deepEqual(gate.translationGate({ ...base, transcriptionsRunning: 1, youtubeBacklog: 4 }), { open: false, waitingFor: 4 });
});

test("20 waiting subtitles open the gate after the current transcription, not during it", () => {
  assert.deepEqual(gate.translationGate({ ...base, youtubeBacklog: 12, subtitlesWaiting: 19 }), { open: false, waitingFor: 12 });
  assert.deepEqual(gate.translationGate({ ...base, youtubeBacklog: 12, subtitlesWaiting: 20 }), { open: true });
  assert.deepEqual(gate.translationGate({ ...base, transcriptionsRunning: 1, youtubeBacklog: 12, subtitlesWaiting: 20 }), { open: false, waitingFor: 12 });
});

test("with nothing left for Whisper the batch translates", () => {
  assert.deepEqual(gate.translationGate(base), { open: true });
});

test("Whisper waits for a running translation batch only on a shared GPU", () => {
  assert.equal(gate.transcriptionMayStart(true, true), false);
  assert.equal(gate.transcriptionMayStart(true, false), true);
  assert.equal(gate.transcriptionMayStart(false, true), true);
});

test("processQueue asks the gate: a held start runs once the backlog clears", async (t) => {
  const taskId = Number(config.createTask({ source_lang: "Automatic", target_lang: "Chinese", output_pattern: "{{name}}.chi.srt", lang_code: "chi" }).lastInsertRowid);
  const srt = path.join(process.env.MEDIA_DIR!, "talk.en.srt");
  const out = path.join(process.env.MEDIA_DIR!, "talk.chi.srt");
  fs.writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nhello\n");
  fs.writeFileSync(out, "already translated");
  const jobId = Number(db.createJob({ task_id: taskId, srt_path: srt, output_path: out, video_path: null }).lastInsertRowid);
  let backlog = 2;
  gate.setYoutubeBacklogSource(() => backlog);
  config.setSetting("gpu_shared", "1");
  t.after(() => {
    config.setSetting("gpu_shared", "0");
    gate.setYoutubeBacklogSource(() => 0);
  });

  await queue.processQueue();
  assert.equal(db.getJob(jobId)!.status, "pending");
  assert.equal(gate.isQueueStartHeld(), true);

  queue.startHeldQueue();
  assert.equal(gate.isQueueStartHeld(), true, "still held while two videos need Whisper");

  backlog = 0;
  queue.startHeldQueue();
  const deadline = Date.now() + 5_000;
  while (db.getJob(jobId)!.status === "pending" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  // The output already exists, so the released run settles the job without an LLM call.
  assert.equal(db.getJob(jobId)!.status, "skipped");
  assert.equal(gate.isQueueStartHeld(), false);
});

test("held starts merge, and one for every job covers a subset", () => {
  gate.holdQueueStart([1, 2]);
  gate.holdQueueStart([2, 3]);
  assert.deepEqual(gate.takeHeldStart(), { ids: [1, 2, 3] });
  gate.holdQueueStart([4]);
  gate.holdQueueStart(undefined);
  assert.deepEqual(gate.takeHeldStart(), { ids: undefined });
  assert.equal(gate.takeHeldStart(), null);
});

test("on a shared GPU a transcription waits for the running translation batch", async (t) => {
  config.setSetting("gpu_shared", "1");
  t.after(() => config.setSetting("gpu_shared", "0"));
  let translating = true;
  let waited = 0;
  const started = gate.waitUntilTranscriptionMayStart(() => translating, new AbortController().signal, () => { waited += 1; }, 5);
  let settled = false;
  void started.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false);
  translating = false;
  await started;
  assert.equal(waited, 1);
});

test("without a shared GPU a transcription never waits for translation", async () => {
  config.setSetting("gpu_shared", "0");
  let waited = false;
  await gate.waitUntilTranscriptionMayStart(() => true, new AbortController().signal, () => { waited = true; }, 5);
  assert.equal(waited, false);
});

test("a cancel ends the wait for the GPU", async (t) => {
  config.setSetting("gpu_shared", "1");
  t.after(() => config.setSetting("gpu_shared", "0"));
  const controller = new AbortController();
  const waiting = gate.waitUntilTranscriptionMayStart(() => true, controller.signal, undefined, 60_000);
  controller.abort();
  await assert.rejects(waiting, /Transcription cancelled/);
});

test("a run the app abandoned keeps translation waiting until the hold ends", async (t) => {
  const inFlight = await import("./transcription/in-flight.js");
  config.setSetting("gpu_shared", "1");
  t.after(() => config.setSetting("gpu_shared", "0"));
  const controller = inFlight.beginTranscriptionRun("/media/abandoned.mkv");
  assert.equal(gate.currentTranslationGate().open, false);
  inFlight.endTranscriptionRun("/media/abandoned.mkv", controller);
  let released = false;
  inFlight.holdGpuForAbandonedRun(() => { released = true; }, 30);
  assert.equal(gate.currentTranslationGate().open, false, "still closed right after the app let go");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(released, true);
  assert.equal(gate.currentTranslationGate().open, true);
});
