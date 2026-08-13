import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LOG_LIMIT,
  parseBoundedNonNegativeInt,
  parsePositiveInteger,
  parsePositiveIntegerArray,
} from "./validation.js";

test("parseBoundedNonNegativeInt applies fallback and maximum", () => {
  assert.equal(parseBoundedNonNegativeInt(undefined, 100, MAX_LOG_LIMIT), 100);
  assert.equal(parseBoundedNonNegativeInt("-1", 100, MAX_LOG_LIMIT), 100);
  assert.equal(parseBoundedNonNegativeInt("not-a-number", 100, MAX_LOG_LIMIT), 100);
  assert.equal(parseBoundedNonNegativeInt("999999", 100, MAX_LOG_LIMIT), MAX_LOG_LIMIT);
  assert.equal(parseBoundedNonNegativeInt("25", 100, MAX_LOG_LIMIT), 25);
});

test("parsePositiveInteger rejects unsafe and non-positive values", () => {
  assert.equal(parsePositiveInteger(1), 1);
  assert.equal(parsePositiveInteger("42"), 42);
  assert.equal(parsePositiveInteger(0), null);
  assert.equal(parsePositiveInteger("-1"), null);
  assert.equal(parsePositiveInteger("1.5"), null);
  assert.equal(parsePositiveInteger(Number.MAX_SAFE_INTEGER + 1), null);
});

test("parsePositiveIntegerArray rejects malformed values and deduplicates", () => {
  assert.deepEqual(parsePositiveIntegerArray([3, "2", 3]), [3, 2]);
  assert.equal(parsePositiveIntegerArray("1,2"), null);
  assert.equal(parsePositiveIntegerArray([1, 0]), null);
  assert.equal(parsePositiveIntegerArray([1, "bad"]), null);
});