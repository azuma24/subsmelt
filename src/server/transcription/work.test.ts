import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkRunner, WorkStore } from "./work.js";
import { enqueueMissingTranscripts } from "./scheduled.js";
import type { ScanResult } from "../scanner.js";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await pause();
  }
  assert.fail("work did not settle");
}

test("batch is durable across reconnect and boot; duplicate submissions reuse active IDs", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-work-"));
  try {
    const file = path.join(dir, "work.json");
    const store = new WorkStore(file);
    const entries = ["one", "two"].map((input) => ({
      kind: "url" as const,
      input: `https://example.org/${input}`,
      request: {},
    }));
    const first = store.enqueue(entries);
    assert.equal(first.length, 2);
    assert.deepEqual(
      store.enqueue(entries).map((item) => item.id),
      first.map((item) => item.id),
    );
    store.update(first[0].id, { status: "running" });
    const reloaded = new WorkStore(file);
    assert.equal(reloaded.recover(), 1);
    assert.equal(reloaded.get(first[0].id)?.status, "queued");
    let runs = 0;
    const runner = new WorkRunner(reloaded, async (item, onProgress) => {
      runs++;
      onProgress(70);
      return { content: `output ${item.input}`, outputFormat: "srt" };
    });
    runner.start();
    await until(() => reloaded.list().every((item) => item.status === "succeeded"));
    await runner.idle();
    assert.equal(runs, 2);
    assert.equal(new WorkStore(file).get(first[0].id)?.content, "output https://example.org/one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit cancellation stops current work and prevents queued work executing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-cancel-"));
  try {
    const store = new WorkStore(path.join(dir, "work.json"));
    const [one, two] = store.enqueue(["one", "two"].map((input) => ({ kind: "url" as const, input, request: {} })));
    let started = 0;
    const runner = new WorkRunner(store, async (_item, _progress, signal) => {
      started++;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("cancelled");
    });
    runner.start();
    await until(() => store.get(one.id)?.status === "running");
    assert.equal(runner.cancel(two.id), true);
    assert.equal(runner.cancel(one.id), true);
    await runner.idle();
    assert.equal(started, 1);
    assert.equal(store.get(two.id)?.status, "cancelled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduled and manual scans share durable claims and respect silence", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-scan-"));
  try {
    const store = new WorkStore(path.join(dir, "work.json"));
    const runner = new WorkRunner(store, async () => ({}));
    runner.start = () => {}; // inspect persisted queue without executing it
    const scan = {
      files: [
        { videoPath: "/media/movie.mkv", subtitles: [] },
        { videoPath: "/media/silent.mkv", subtitles: [] },
        { videoPath: "/media/subbed.mkv", subtitles: ["sub"] },
      ],
    } as unknown as ScanResult;
    enqueueMissingTranscripts(scan, "auto_transcribe_and_translate", runner, (p) => p.includes("silent"));
    enqueueMissingTranscripts(scan, "auto_transcribe_and_translate", runner, (p) => p.includes("silent"));
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].request.postAction, "transcribe_and_translate");
    enqueueMissingTranscripts(scan, "ask", runner, () => false);
    assert.equal(store.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
