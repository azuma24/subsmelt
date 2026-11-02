import test from "node:test";
import assert from "node:assert/strict";
import { axisCost, axisTokens, niceTicks, sampledLabels } from "./chart-scale";

test("y ticks climb in clean steps to a ceiling at or above the peak", () => {
  assert.deepEqual(niceTicks(78_400), [0, 50_000, 100_000]);
  assert.deepEqual(niceTicks(0.22), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(niceTicks(1_250), [0, 500, 1_000, 1_500]);
  assert.deepEqual(niceTicks(0), [0, 1]);
});

test("date labels are spaced out and always include the newest day", () => {
  assert.deepEqual(sampledLabels(7, 140, 72), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(sampledLabels(30, 30, 72), [2, 5, 8, 11, 14, 17, 20, 23, 26, 29]);
  assert.deepEqual(sampledLabels(1, 900, 72), [0]);
  assert.deepEqual(sampledLabels(0, 10, 72), []);
});

test("axis labels stay short", () => {
  assert.deepEqual([0, 950, 2_500, 100_000, 1_250_000].map(axisTokens), ["0", "950", "2.5k", "100k", "1.25M"]);
  assert.deepEqual([0, 0.005, 0.1, 0.3, 250].map(axisCost), ["$0", "$0.005", "$0.10", "$0.30", "$250"]);
});
