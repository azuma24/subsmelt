import test from "node:test";
import assert from "node:assert/strict";
import type { ResolvedConnection } from "../connections.js";
import { type ChunkAttempt, awayFromDownMachines, createChunkHedger } from "./chunk-hedge.js";
import type { SubtitleCue } from "./utils.js";

const conn = (id: string, host = `${id}.test`): ResolvedConnection => ({
  id,
  label: id,
  apiKey: "",
  apiHost: `http://${host}/v1`,
  model: "m",
});
const block = (): SubtitleCue[] => [] as SubtitleCue[];
const FAST = { pollMs: 2, minWaitMs: 10, noHistoryWaitMs: 40 };

function setup(connections: ResolvedConnection[], overrides: { usable?: () => ResolvedConnection[] } = {}) {
  const job = new AbortController();
  const sent: ChunkAttempt[] = [];
  let duplicate: (attempt: ChunkAttempt) => Promise<unknown> = () => new Promise(() => {});
  const hedger = createChunkHedger({
    connections,
    usable: overrides.usable ?? ((order) => order),
    jobSignal: job.signal,
    runDuplicate: (_, attempt) => {
      sent.push(attempt);
      return duplicate(attempt);
    },
    timing: FAST,
  });
  return {
    job,
    sent,
    hedger,
    onDuplicate: (fn: (attempt: ChunkAttempt) => Promise<unknown>) => {
      duplicate = fn;
    },
  };
}

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 1));
  }
};

/** Finishes a quick chunk so the hedger has a normal time to compare with. */
function finishQuickChunk(hedger: ReturnType<typeof setup>["hedger"]) {
  const quick = block();
  assert.equal(hedger.claimWin(hedger.startOriginal(quick)), true);
  hedger.finish(quick);
}

test("a stalled chunk gets one duplicate at a time, on another connection", async () => {
  const [a, b, c] = [conn("a"), conn("b"), conn("c")];
  const { job, sent, hedger } = setup([a, b, c]);
  finishQuickChunk(hedger);
  const stuck = block();
  hedger.startOriginal(stuck).record.conn = a;
  const idle = hedger.runIdleLoop();
  await until(() => sent.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    sent.map((attempt) => attempt.targetConn?.id),
    ["b"],
  );
  job.abort();
  hedger.finish(stuck);
  void idle.catch(() => {});
});

test("a failed duplicate moves on to a connection not tried yet", async () => {
  const [a, b, c] = [conn("a"), conn("b"), conn("c")];
  const { sent, hedger, onDuplicate, job } = setup([a, b, c]);
  onDuplicate((attempt) =>
    attempt.targetConn?.id === "b" ? Promise.reject(new Error("down")) : new Promise(() => {}),
  );
  finishQuickChunk(hedger);
  const stuck = block();
  hedger.startOriginal(stuck).record.conn = a;
  void hedger.runIdleLoop();
  const other = hedger.runIdleLoop();
  await until(() => sent.length === 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    sent.map((attempt) => attempt.targetConn?.id),
    ["b", "c"],
  );
  job.abort();
  hedger.finish(stuck);
  void other;
});

test("a connection on the stalled machine is not another machine", async () => {
  const a = conn("a", "gpu.test:1234");
  const sameBox = conn("same", "gpu.test:8001");
  const elsewhere = conn("b", "other.test");
  const { sent, hedger, job } = setup([a, sameBox, elsewhere]);
  finishQuickChunk(hedger);
  const stuck = block();
  hedger.startOriginal(stuck).record.conn = a;
  void hedger.runIdleLoop();
  await until(() => sent.length === 1);
  assert.equal(sent[0].targetConn?.id, "b");
  job.abort();
  hedger.finish(stuck);
});

test("the stalled connection itself is never the target, even with no host to compare", async () => {
  const cloud = (id: string): ResolvedConnection => ({
    ...conn(id),
    apiHost: "http://localhost:8000/v1",
    provider: "openai",
  });
  const [a, b] = [cloud("a"), cloud("b")];
  const { sent, hedger, job } = setup([a, b]);
  finishQuickChunk(hedger);
  const stuck = block();
  hedger.startOriginal(stuck).record.conn = a;
  void hedger.runIdleLoop();
  await until(() => sent.length === 1);
  assert.equal(sent[0].targetConn?.id, "b");
  job.abort();
  hedger.finish(stuck);
});

test("connections the engine rules out are never targets", async () => {
  const [a, down] = [conn("a"), conn("down")];
  const { sent, hedger } = setup([a, down], { usable: () => [a] });
  finishQuickChunk(hedger);
  const stuck = block();
  hedger.startOriginal(stuck).record.conn = a;
  const idle = hedger.runIdleLoop();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, 0);
  hedger.finish(stuck);
  await idle;
});

test("with no finished chunk, a stall waits the longer no-history time", async () => {
  const [a, b] = [conn("a"), conn("b")];
  const { sent, hedger, job } = setup([a, b]);
  const stuck = block();
  const started = Date.now();
  hedger.startOriginal(stuck).record.conn = a;
  void hedger.runIdleLoop();
  await until(() => sent.length === 1);
  assert.ok(Date.now() - started >= FAST.noHistoryWaitMs);
  job.abort();
  hedger.finish(stuck);
});

test("a requeued chunk starts its wait again and keeps its record", async () => {
  const [a, b] = [conn("a"), conn("b")];
  const { sent, hedger, job } = setup([a, b]);
  finishQuickChunk(hedger);
  const stuck = block();
  const first = hedger.startOriginal(stuck);
  first.record.conn = a;
  await new Promise((r) => setTimeout(r, FAST.minWaitMs + 5));
  const second = hedger.startOriginal(stuck);
  assert.equal(second.record, first.record);
  assert.notEqual(second.controller, first.controller);
  const restarted = Date.now();
  void hedger.runIdleLoop();
  await until(() => sent.length === 1);
  assert.ok(Date.now() - restarted >= FAST.minWaitMs - 2);
  job.abort();
  hedger.finish(stuck);
});

test("only the first claim wins, and the other attempt is terminated", async () => {
  const [a, b] = [conn("a"), conn("b")];
  const { sent, hedger, job } = setup([a, b]);
  finishQuickChunk(hedger);
  const stuck = block();
  const original = hedger.startOriginal(stuck);
  original.record.conn = a;
  void hedger.runIdleLoop();
  await until(() => sent.length === 1);
  const [duplicate] = sent;
  assert.equal(hedger.claimWin(duplicate), true);
  assert.equal(original.controller.signal.aborted, true);
  assert.equal(hedger.claimWin(original), false);
  assert.equal(original.record.winner, duplicate);
  job.abort();
  hedger.finish(stuck);
});

test("an error from a duplicate that already won fails the job", async () => {
  const [a, b] = [conn("a"), conn("b")];
  const { hedger, onDuplicate } = setup([a, b]);
  onDuplicate(async (attempt) => {
    hedger.claimWin(attempt);
    throw new Error("disk full");
  });
  finishQuickChunk(hedger);
  hedger.startOriginal(block()).record.conn = a;
  await assert.rejects(hedger.runIdleLoop(), /disk full/);
});

test("the idle loop ends as soon as the last chunk finishes or the job aborts", async () => {
  const slowPoll = { pollMs: 60_000, minWaitMs: 10, noHistoryWaitMs: 40 };
  const job = new AbortController();
  const hedger = createChunkHedger({
    connections: [conn("a")],
    usable: (order) => order,
    jobSignal: job.signal,
    runDuplicate: () => Promise.resolve(),
    timing: slowPoll,
  });
  const started = Date.now();
  const first = block();
  hedger.startOriginal(first);
  const idle = hedger.runIdleLoop();
  hedger.finish(first);
  await idle;

  const second = block();
  hedger.startOriginal(second);
  const aborted = hedger.runIdleLoop();
  job.abort();
  await aborted;
  assert.ok(Date.now() - started < 1_000);
});

test("a machine found down rules out every connection on it", () => {
  const down = conn("down", "gpu.test:1234");
  const sameBox = conn("same", "gpu.test:8001");
  const elsewhere = conn("b", "other.test");
  const all = [down, sameBox, elsewhere];
  assert.deepEqual(
    awayFromDownMachines(all, all, (id) => id === "down").map((c) => c.id),
    ["b"],
  );
});

test("a slow normal time pushes the wait past twice the average", async () => {
  const [a, b] = [conn("a"), conn("b")];
  const { sent, hedger, job } = setup([a, b]);
  const normal = block();
  const attempt = hedger.startOriginal(normal);
  await new Promise((r) => setTimeout(r, 60));
  hedger.claimWin(attempt);
  hedger.finish(normal);
  const stuck = block();
  const started = Date.now();
  hedger.startOriginal(stuck).record.conn = a;
  void hedger.runIdleLoop();
  await until(() => sent.length === 1);
  assert.ok(Date.now() - started >= 115, `sent after ${Date.now() - started}ms`);
  job.abort();
  hedger.finish(stuck);
});

test("cloud connections are neither local nor one machine, despite their default host", () => {
  const local = conn("local", "localhost:8000");
  const cloud = (id: string): ResolvedConnection => ({
    ...conn(id),
    apiHost: "http://localhost:8000/v1",
    provider: "openai",
  });
  const all = [local, cloud("x"), cloud("y")];
  assert.deepEqual(
    awayFromDownMachines(all, all, (id) => id === "local").map((c) => c.id),
    ["x", "y"],
  );
  assert.deepEqual(
    awayFromDownMachines(all, all, (id) => id === "x").map((c) => c.id),
    ["local", "y"],
  );
});
