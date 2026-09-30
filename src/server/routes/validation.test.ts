import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LOG_LIMIT,
  parseBoundedNonNegativeInt,
  parsePositiveInteger,
  parsePositiveIntegerArray,
  parseTaskUpdate,
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
test("parseTaskUpdate keeps only the editable task fields", () => {
  assert.deepEqual(
    parseTaskUpdate({ id: 99, created_at: "x", target_lang: "Deutsch", enabled: 0, prompt_override: "" }),
    { ok: true, value: { target_lang: "Deutsch", enabled: 0, prompt_override: "" } },
  );
});

test("parseTaskUpdate rejects editable fields of the wrong type", () => {
  assert.deepEqual(parseTaskUpdate({ output_pattern: 5 }), { ok: false, error: "output_pattern must be a string" });
  assert.deepEqual(parseTaskUpdate({ enabled: "0" }), { ok: false, error: "enabled must be 0 or 1" });
  assert.deepEqual(parseTaskUpdate({ lang_code: "" }), { ok: false, error: "lang_code must not be empty" });
  assert.deepEqual(parseTaskUpdate(["French"]), { ok: false, error: "Request body must be a JSON object" });
});
