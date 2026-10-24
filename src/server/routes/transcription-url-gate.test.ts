import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// Its own file: cancelled runs elsewhere hold the GPU gate for minutes in-process.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-url-gate-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = path.join(root, "media");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });

const { setSettings } = await import("../config.js");
const { holdQueueStart, isQueueStartHeld } = await import("../gpu-gate.js");
const { transcriptionWork } = await import("../transcription/work.js");
const { withTranscriptionRun } = await import("./transcription-runtime.js");

let arrivals = 0;
let answer!: () => void;
const received = new Promise<void>((resolve) => {
  answer = resolve;
});
const backend = http.createServer((req, res) => {
  req.resume();
  arrivals += 1;
  answer();
  const result = { type: "result", ok: true, content: "hello", language: "en", segments: 1 };
  // Answers after the test has held a queue start.
  setTimeout(
    () => res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(`${JSON.stringify(result)}\n`),
    200,
  );
});
backend.listen(0, "127.0.0.1");
await once(backend, "listening");
after(() => {
  backend.closeAllConnections();
  backend.close();
});

test("a translation start held while URL work used the shared GPU begins when that work ends", async () => {
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
    gpu_shared: "1",
  });
  const [item] = transcriptionWork.store.enqueue([{ kind: "url", input: "https://example.net/held", request: {} }]);
  transcriptionWork.start();
  await received;
  // What a Start Queue does while Whisper holds the shared GPU.
  holdQueueStart(undefined);

  await transcriptionWork.idle();
  assert.equal(transcriptionWork.store.get(item.id)?.status, "succeeded");
  assert.equal(isQueueStartHeld(), false);
});

test("URL work waits for a free transcription slot like a file run", async () => {
  setSettings({ gpu_shared: "0", transcription_max_concurrent: "1" });
  const before = arrivals;
  let releaseSlot!: () => void;
  // Another run, an auto-transcription say, holds the only slot.
  const other = withTranscriptionRun("auto-run.mkv", undefined, (run) =>
    run.withGpu(() => new Promise<void>((resolve) => (releaseSlot = resolve))),
  );
  const [item] = transcriptionWork.store.enqueue([{ kind: "url", input: "https://example.net/slot", request: {} }]);
  transcriptionWork.start();

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(arrivals, before, "the URL run must not reach the backend while the slot is taken");

  releaseSlot();
  await other;
  await transcriptionWork.idle();
  assert.equal(arrivals, before + 1);
  assert.equal(transcriptionWork.store.get(item.id)?.status, "succeeded");
});
