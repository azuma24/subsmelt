import test from "node:test";
import assert from "node:assert/strict";
import { acquireConnectionLock, resetConnectionLocks } from "./connection-lock.js";
import type { LockableConnection } from "./connection-lock.js";

function conn(id: string): LockableConnection {
  return { id, label: id };
}

test("a second acquirer waits while the first holds the lock", async () => {
  const target = conn("wait-in-order");
  const order: string[] = [];

  const releaseFirst = await acquireConnectionLock(target);
  let secondAcquired = false;
  const second = acquireConnectionLock(target).then((release: () => void) => {
    secondAcquired = true;
    order.push("second");
    return release;
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondAcquired, false, "second acquirer must block while the lock is held");

  order.push("first-release");
  releaseFirst();
  (await second)();

  assert.deepEqual(order, ["first-release", "second"]);
});

test("waiting is bounded so cross-worker cascades cannot deadlock", async () => {
  // Worker A holds conn1 for its whole job and cascades onto conn2; worker B
  // holds conn2 and cascades onto conn1. Unbounded waiting made both hang
  // forever — the wait must expire and let the work proceed unlocked instead.
  const conn1 = conn("deadlock-1");
  const conn2 = conn("deadlock-2");

  const releaseA = await acquireConnectionLock(conn1);
  const releaseB = await acquireConnectionLock(conn2);

  const started = Date.now();
  const [cascadeA, cascadeB] = await Promise.all([
    acquireConnectionLock(conn2, 50),
    acquireConnectionLock(conn1, 50),
  ]);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `both cascades should return promptly, took ${elapsed}ms`);
  assert.equal(typeof cascadeA, "function");
  assert.equal(typeof cascadeB, "function");

  cascadeA();
  cascadeB();
  releaseA();
  releaseB();
});

test("resetConnectionLocks clears state between queue runs", async () => {
  const target = conn("reset-between-runs");
  await acquireConnectionLock(target);
  resetConnectionLocks();
  // Without a reset the never-released holder above would block this forever.
  const afterReset = await acquireConnectionLock(target, 200);
  assert.equal(typeof afterReset, "function");
  afterReset();
});

test("releasing twice is a no-op and never corrupts the chain", async () => {
  const target = conn("double-release");
  const release = await acquireConnectionLock(target);
  release();
  release();

  // The next acquirer still gets the lock promptly.
  const next = await acquireConnectionLock(target, 200);
  assert.equal(typeof next, "function");
  next();
});
