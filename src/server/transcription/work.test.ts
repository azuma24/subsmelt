import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkConflict, WorkRunner, WorkStore, type WorkInput } from "./work.js";
import { createWorkPlan } from "./work-plan.js";
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

test("active work reuses equivalent plans and conflicts leave the whole batch unchanged", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-work-conflict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "work.json");
  const planner = (input: WorkInput) => createWorkPlan(input, { transcription_model: "small" });
  const store = new WorkStore(file, planner);
  const input: WorkInput = { kind: "url", input: "https://example.org/talk", request: {} };
  const different = { ...input, request: { model: "large-v3" } };
  const same = { ...input, request: { model: "small" } };
  const receipt = { key: "first", digest: "one" };
  const [active] = store.enqueue([input], receipt);

  const reloaded = new WorkStore(file, planner);
  assert.equal(reloaded.enqueue([same])[0].id, active.id);
  const onDisk = readFileSync(file, "utf8");
  const newInput = { ...input, input: "https://example.org/other" };
  const secondReceipt = { key: "batch", digest: "two" };
  assert.throws(() => reloaded.enqueue([newInput, different], secondReceipt), WorkConflict);
  assert.throws(() => reloaded.enqueue([newInput, { ...different, input: newInput.input }]), WorkConflict);
  assert.equal(readFileSync(file, "utf8"), onDisk);
  assert.deepEqual(
    reloaded.list().map(({ id }) => id),
    [active.id],
  );
  assert.equal(reloaded.enqueue([newInput], secondReceipt).length, 1);

  const changedDefaults = new WorkStore(file, (item) => createWorkPlan(item, { transcription_model: "large-v3" }));
  assert.throws(() => changedDefaults.enqueue([input]), WorkConflict);
  assert.equal(changedDefaults.enqueue([input], receipt)[0].id, active.id);
});

test("legacy active work without a plan reuses its original request", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-work-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "work.json");
  const input: WorkInput = { kind: "url", input: "https://example.org/legacy", request: { model: "small" } };
  const receipt = { key: "legacy", digest: "old-digest" };
  const [active] = new WorkStore(file).enqueue([input], receipt);
  const reloaded = new WorkStore(file, (item) => createWorkPlan(item, {}));
  assert.equal(reloaded.enqueue([input])[0].id, active.id);
  assert.equal(reloaded.enqueue([input], receipt)[0].id, active.id);
  assert.throws(() => reloaded.enqueue([{ ...input, request: { model: "large-v3" } }]), WorkConflict);
  assert.throws(() => reloaded.enqueue([{ ...input, request: { ...input.request, exportNote: true } }]), WorkConflict);
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

test("scheduled and manual scans share durable claims and respect silence", async () => {
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
    await enqueueMissingTranscripts(scan, "auto_transcribe_and_translate", {
      runner,
      silent: (p) => p.includes("silent"),
    });
    await enqueueMissingTranscripts(scan, "auto_transcribe_and_translate", {
      runner,
      silent: (p) => p.includes("silent"),
    });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].request.postAction, "transcribe_and_translate");
    const changed = { files: [{ videoPath: "/media/new.mkv", subtitles: [] }, ...scan.files] } as ScanResult;
    await enqueueMissingTranscripts(changed, "auto_transcribe", { runner, silent: (p) => p.includes("silent") });
    assert.deepEqual(
      store.list().map((item) => item.request.postAction),
      ["transcribe_and_translate", "transcribe_only"],
    );
    await enqueueMissingTranscripts(scan, "ask", { runner, silent: () => false });
    assert.equal(store.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large URL results stay outside the manifest; progress writes are throttled and output survives restart", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-work-output-"));
  try {
    const file = path.join(dir, "work.json");
    const store = new WorkStore(file);
    const [item] = store.enqueue([{ kind: "url", input: "https://example.org/long", request: {} }]);
    store.update(item.id, { status: "running" });
    store.update(item.id, { progress: 1 });
    const onDisk = readFileSync(file, "utf8");
    store.update(item.id, { progress: 2 });
    assert.equal(readFileSync(file, "utf8"), onDisk);
    const content = "line\n".repeat(200_000);
    store.update(item.id, { status: "succeeded", content, progress: 100 });
    assert.ok(readFileSync(file, "utf8").length < 2000);
    assert.equal(new WorkStore(file).get(item.id)?.content, content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention prunes completed outputs but keeps active work regardless of age", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-work-retain-"));
  try {
    const file = path.join(dir, "work.json");
    const store = new WorkStore(file);
    const [done, active] = store.enqueue(
      ["done", "active"].map((input) => ({ kind: "url" as const, input, request: {} })),
    );
    store.update(done.id, { status: "succeeded", content: "saved" });
    const entries = JSON.parse(readFileSync(file, "utf8"));
    for (const entry of entries) entry.updatedAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(file, JSON.stringify(entries));
    const reloaded = new WorkStore(file);
    assert.equal(reloaded.get(done.id), undefined);
    assert.equal(existsSync(path.join(`${file}.outputs`, done.id)), false);
    assert.equal(reloaded.get(active.id)?.status, "queued");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy inline URL output migrates to an artifact without losing download", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-work-migrate-"));
  try {
    const file = path.join(dir, "work.json");
    const store = new WorkStore(file);
    const [item] = store.enqueue([{ kind: "url", input: "legacy", request: {} }]);
    const entries = JSON.parse(readFileSync(file, "utf8"));
    entries[0].status = "succeeded";
    entries[0].content = "legacy transcript";
    writeFileSync(file, JSON.stringify(entries));
    const migrated = new WorkStore(file);
    assert.equal(migrated.get(item.id)?.content, "legacy transcript");
    assert.doesNotMatch(readFileSync(file, "utf8"), /legacy transcript/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable work file is set aside and the store starts empty", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subsmelt-work-"));
  try {
    const file = path.join(dir, "work.json");
    writeFileSync(file, '[{"id":"half-writ');
    const store = new WorkStore(file);
    assert.deepEqual(store.list(), []);
    const aside = readdirSync(dir).filter((name) => name.startsWith("work.json.unreadable-"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(path.join(dir, aside[0]), "utf8"), '[{"id":"half-writ');
    assert.equal(store.enqueue([{ kind: "url", input: "https://example.org/after", request: {} }]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
