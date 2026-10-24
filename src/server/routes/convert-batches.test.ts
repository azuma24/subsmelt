import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-convert-test-"));
process.env.CONVERT_BATCH_DIR = root;
const { ConvertBatchStore, registerConvertBatchRoutes, MAX_BATCH_FILES, MAX_BATCH_FILE_BYTES, BATCH_TTL_MS } =
  await import("./convert-batches.js");
const file = (name = "a.srt") => ({ name, content: "1\n00:00:01,000 --> 00:00:02,000\nHi\n", skip: false });
const request = (files = [file()]) => ({ files, targetFormat: "vtt", translate: false });
const wait = async (store: InstanceType<typeof ConvertBatchStore>, id: string) => {
  for (let i = 0; i < 100; i++) {
    if (store.get(id)?.status === "done") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("batch did not settle");
};

test("disconnect does not abort; output survives reconnect, restart and rejects arbitrary paths", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new ConvertBatchStore(async (input) => {
    await gate;
    return input.content;
  });
  const id = store.create(request());
  assert.equal(store.get(id)?.files[0].status, "working");
  // No request/response object is held by the worker; reconnect is a fresh lookup.
  release();
  await wait(store, id);
  const reopened = new ConvertBatchStore(async () => {
    throw new Error("Already finished");
  });
  assert.equal(reopened.output(id, 0)?.content.toString(), file().content);
  assert.equal(reopened.output("../../etc/passwd", 0), null);
  assert.equal(reopened.output(id, -1), null);
  assert.equal(reopened.output(id, 1), null);
  assert.equal(reopened.get("not-an-id"), null);
});

test("unfinished work resumes after restart, completed files are not repeated; failures isolated", async () => {
  const initial = new ConvertBatchStore(async (input) => {
    if (input.name === "bad.srt") throw new Error("bad cue");
    return input.content;
  });
  const id = initial.create(request([file("ok.srt"), file("bad.srt")]));
  await wait(initial, id);
  assert.deepEqual(
    initial.get(id)?.files.map((f) => f.status),
    ["done", "error"],
  );
  assert.equal(initial.output(id, 1), null);
  const dir = path.join(root, id);
  const job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
  job.status = "running";
  job.finishedAt = undefined;
  job.files[1].status = "working";
  fs.writeFileSync(path.join(dir, "input-1"), file("bad.srt").content);
  fs.writeFileSync(
    path.join(dir, "inputs.json"),
    JSON.stringify([file("ok.srt"), file("bad.srt")].map(({ name, skip }) => ({ name, skip }))),
  );
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
  let calls = 0;
  const resumed = new ConvertBatchStore(async () => {
    calls++;
    return "recovered";
  });
  await wait(resumed, id);
  assert.equal(calls, 1);
  assert.deepEqual(
    resumed.get(id)?.files.map((f) => f.status),
    ["done", "done"],
  );
  assert.equal(resumed.output(id, 1)?.content.toString(), "recovered");
});

test("bounds, expiry, and symlink output access", async () => {
  const store = new ConvertBatchStore(async (input) => input.content);
  assert.throws(() => store.create(request(Array.from({ length: MAX_BATCH_FILES + 1 }, () => file()))), /File count/);
  assert.throws(
    () => store.create(request([{ ...file(), content: "x".repeat(MAX_BATCH_FILE_BYTES + 1) }])),
    /size limit/,
  );
  assert.throws(() => store.create(request([{ ...file(), name: "a/../../bad.srt" }])), /Invalid file|Invalid/);
  const id = store.create(request());
  await wait(store, id);
  const output = path.join(root, id, "output-0");
  fs.rmSync(output);
  fs.symlinkSync(path.join(root, id, "job.json"), output);
  assert.equal(store.output(id, 0), null);
  const job = JSON.parse(fs.readFileSync(path.join(root, id, "job.json"), "utf8"));
  job.finishedAt = Date.now() - BATCH_TTL_MS - 1;
  fs.writeFileSync(path.join(root, id, "job.json"), JSON.stringify(job));
  assert.equal(store.get(id), null);
  new ConvertBatchStore(async () => "");
  assert.equal(fs.existsSync(path.join(root, id)), false);
});

test("a second batch created while a worker is busy runs without a minute-long wait", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new ConvertBatchStore(async (input) => {
    if (input.name === "first.srt") await gate;
    return input.content;
  });
  const first = store.create(request([file("first.srt")]));
  const second = store.create(request([file("second.srt")]));
  release();
  await wait(store, first);
  await wait(store, second);
  assert.ok(store.output(second, 0));
});

test("oversized generated output is discarded without blocking following files", async () => {
  const store = new ConvertBatchStore(async (input) =>
    input.name === "huge.srt" ? "x".repeat(MAX_BATCH_FILE_BYTES + 1) : input.content,
  );
  const id = store.create(request([file("huge.srt"), file("small.srt")]));
  await wait(store, id);
  assert.deepEqual(
    store.get(id)?.files.map((entry) => entry.status),
    ["error", "done"],
  );
  assert.equal(store.output(id, 0), null);
  assert.ok(store.output(id, 1));
  const dir = path.join(root, id);
  assert.equal(fs.existsSync(path.join(dir, "input-0")), false);
  assert.equal(fs.existsSync(path.join(dir, "input-1")), false);
});

test("HTTP route returns promptly, survives dropped client and restricts output to completed files", async () => {
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  registerConvertBatchRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const base = `http://127.0.0.1:${address.port}/api/convert/batches`;
    const response = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 202);
    const { id } = (await response.json()) as { id: string };
    assert.equal((await fetch(`${base}/${id}/files/999`)).status, 404);
    // The POST response is gone; a new request still sees server-owned progress/output.
    for (let i = 0; i < 100; i++) {
      const status = (await (await fetch(`${base}/${id}`)).json()) as { status: string; files: unknown[] };
      assert.equal(JSON.stringify(status).includes(file().content), false);
      if (status.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = await fetch(`${base}/${id}/files/0`);
    assert.equal(result.status, 200);
    assert.match(await result.text(), /WEBVTT/);
    assert.equal((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
