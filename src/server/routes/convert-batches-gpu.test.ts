import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts and convert-batches.ts bind their folders at import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-convert-gpu-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = path.join(root, "media");
process.env.CONVERT_BATCH_DIR = path.join(root, "batches");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });

const { setSettings } = await import("../config.js");
const { ConvertBatchStore } = await import("./convert-batches.js");
const { convertHoldsGpu } = await import("../gpu-gate.js");
const { beginTranscriptionRun, endTranscriptionRun } = await import("../transcription/in-flight.js");
const { waitForGpu } = await import("./transcription-runtime.js");

const cue = "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
const translateRequest = (name: string) => ({
  files: [{ name, content: cue, skip: false }],
  targetFormat: "srt",
  translate: true,
  targetLang: "German",
  targetCode: "de",
});

async function until(condition: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("with the setting on, a translating batch waits for a running transcription", async () => {
  setSettings({ gpu_shared: "1", convert_gpu_shared: "1" });
  const transcription = beginTranscriptionRun(path.join(root, "media", "a.mkv"));
  let translated = 0;
  const store = new ConvertBatchStore(async (input) => {
    translated += 1;
    return input.content;
  });
  try {
    const id = store.create(translateRequest("wait.srt"));
    await until(() => store.get(id)?.status === "waiting", "the batch to report it waits for the GPU");
    assert.equal(translated, 0);

    endTranscriptionRun(path.join(root, "media", "a.mkv"), transcription);
    await until(() => store.get(id)?.status === "done", "the batch to finish", 5_000);
    assert.equal(translated, 1);
    assert.equal(convertHoldsGpu(), false, "a finished batch gives the GPU back");
  } finally {
    endTranscriptionRun(path.join(root, "media", "a.mkv"), transcription);
  }
});

test("with the setting off, a translating batch runs beside a transcription", async () => {
  setSettings({ gpu_shared: "1", convert_gpu_shared: "0" });
  const transcription = beginTranscriptionRun(path.join(root, "media", "b.mkv"));
  const store = new ConvertBatchStore(async (input) => input.content);
  try {
    const id = store.create(translateRequest("beside.srt"));
    await until(() => store.get(id)?.status === "done", "the batch to finish without waiting", 500);
  } finally {
    endTranscriptionRun(path.join(root, "media", "b.mkv"), transcription);
  }
});

test("with the setting on, a transcription waits for a translating batch", async () => {
  setSettings({ gpu_shared: "1", convert_gpu_shared: "1" });
  let finishTranslation!: () => void;
  const translating = new Promise<void>((resolve) => (finishTranslation = resolve));
  const store = new ConvertBatchStore(async (input) => {
    await translating;
    return input.content;
  });
  const id = store.create(translateRequest("hold.srt"));
  await until(() => convertHoldsGpu(), "the batch to take the GPU");

  let started = false;
  const transcription = waitForGpu("https://example.org/held", new AbortController().signal).then(() => {
    started = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(started, false);

  finishTranslation();
  await until(() => store.get(id)?.status === "done", "the batch to finish");
  await transcription;
  assert.equal(started, true);
});
