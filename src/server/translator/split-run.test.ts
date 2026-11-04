import test from "node:test";
import assert from "node:assert/strict";
import type { ResolvedConnection } from "../connections.js";
import { MAX_SPLIT_WORKERS, createSplitRun } from "./split-run.js";

const conn = (id: string): ResolvedConnection => ({
  id,
  label: id,
  apiKey: "",
  apiHost: `http://${id}.test/v1`,
  model: "m",
});

test("workers follow each connection's own limit", () => {
  const [a, b] = [conn("a"), conn("b")];
  const run = createSplitRun(
    [a, b],
    new Map([
      ["a", 3],
      ["b", 1],
    ]),
  );
  assert.deepEqual(
    run.workerPrimaries.map((c) => c.id),
    ["a", "b", "a", "a"],
  );
});

test("a file never runs more workers than the ceiling", () => {
  const connections = ["a", "b", "c", "d", "e"].map(conn);
  const run = createSplitRun(connections, new Map(connections.map((c) => [c.id, 8])));
  assert.equal(run.workerPrimaries.length, MAX_SPLIT_WORKERS);
  assert.equal(MAX_SPLIT_WORKERS, 32);
});

test("one connection's limit does not hold back another", async () => {
  const [a, b] = [conn("a"), conn("b")];
  const run = createSplitRun(
    [a, b],
    new Map([
      ["a", 1],
      ["b", 1],
    ]),
  );
  const releaseA = await run.acquire(a);
  let waiterGotSlot = false;
  const waiter = run.acquire(a).then((release) => {
    waiterGotSlot = true;
    return release;
  });
  const releaseB = await run.acquire(b);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(waiterGotSlot, false);
  releaseA();
  (await waiter)();
  releaseB();
});

test("an abort ends a wait for a slot and keeps the cancel's identity", async () => {
  const a = conn("a");
  const run = createSplitRun([a], new Map([["a", 1]]));
  const release = await run.acquire(a);
  const controller = new AbortController();
  const waiting = run.acquire(a, controller.signal);
  controller.abort(new Error("JOB_CANCELLED"));
  await assert.rejects(waiting, /^Error: JOB_CANCELLED$/);
  release();
  (await run.acquire(a))();
});

test("two connections on one server share its limit; cloud connections do not", async () => {
  const shared = (id: string): ResolvedConnection => ({ ...conn(id), apiHost: "http://gpu.test:1234/v1" });
  const cloud = (id: string): ResolvedConnection => ({
    ...conn(id),
    apiHost: "http://localhost:8000/v1",
    provider: "openai",
  });
  const [a, b, x, y] = [shared("a"), shared("b"), cloud("x"), cloud("y")];
  const run = createSplitRun(
    [a, b, x, y],
    new Map([
      ["a", 3],
      ["b", 1],
      ["x", 1],
      ["y", 1],
    ]),
  );
  assert.deepEqual([run.limitOf(a), run.limitOf(b)], [1, 1]);
  const release = await run.acquire(a);
  let second = false;
  const waiter = run.acquire(b).then((done) => {
    second = true;
    return done;
  });
  const releases = [await run.acquire(x), await run.acquire(y)];
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(second, false);
  release();
  (await waiter)();
  for (const done of releases) done();
});

test("an overflow halves only that connection, once per observed limit", () => {
  const [a, b] = [conn("a"), conn("b")];
  const run = createSplitRun(
    [a, b],
    new Map([
      ["a", 4],
      ["b", 4],
    ]),
  );
  assert.equal(run.halveFrom(a, 4), true);
  assert.equal(run.halveFrom(a, 4), false);
  assert.deepEqual([run.limitOf(a), run.limitOf(b)], [2, 4]);
});

test("one server gets one worker per request it can take, however its URL is spelled", () => {
  const a = { ...conn("a"), apiHost: "http://GPU.test:1234/v1/" };
  const b = { ...conn("b"), apiHost: "http://gpu.test:1234/v1" };
  const c = conn("c");
  const run = createSplitRun(
    [a, b, c],
    new Map([
      ["a", 4],
      ["b", 2],
      ["c", 2],
    ]),
  );
  assert.deepEqual([run.limitOf(a), run.limitOf(b)], [2, 2]);
  assert.deepEqual(
    run.workerPrimaries.map((w) => w.id),
    ["a", "c", "b", "c"],
  );
});
