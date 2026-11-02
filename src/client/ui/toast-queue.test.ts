import { test } from "node:test";
import assert from "node:assert/strict";
import { toastsAwaitingTimer, visibleToasts } from "./toast-queue.js";

const toast = (id: number, persistent = false) => ({ id, persistent });

test("only the newest four toasts are visible", () => {
  const all = [1, 2, 3, 4, 5, 6].map((id) => toast(id));
  assert.deepEqual(
    visibleToasts(all).map((t) => t.id),
    [3, 4, 5, 6],
  );
});

test("a queued toast gets no dismiss timer until it becomes visible", () => {
  const all = [1, 2, 3, 4, 5, 6].map((id) => toast(id));
  assert.deepEqual(toastsAwaitingTimer(all, new Set()), [3, 4, 5, 6]);

  const afterTwoDismissed = all.slice(2);
  assert.deepEqual(toastsAwaitingTimer(afterTwoDismissed, new Set([3, 4, 5, 6])), []);

  const afterFourDismissed = [toast(1), toast(2)];
  assert.deepEqual(toastsAwaitingTimer(afterFourDismissed, new Set()), [1, 2]);
});

test("persistent toasts never get a dismiss timer", () => {
  assert.deepEqual(toastsAwaitingTimer([toast(1, true), toast(2)], new Set()), [2]);
});
