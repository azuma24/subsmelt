import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRetryAfter,
  rateLimitRetryDelayMs,
  extractUsage,
  type TokenUsage,
} from "./ai-client.js";

// ── parseRetryAfter ─────────────────────────────────────────────────────────

test("parseRetryAfter: delta-seconds is converted to ms", () => {
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(" 5 "), 5_000);
});

test("parseRetryAfter: HTTP-date is converted to a delay relative to now", () => {
  const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  const future = "Wed, 21 Oct 2015 07:28:30 GMT"; // +30s
  assert.equal(parseRetryAfter(future, now), 30_000);
});

test("parseRetryAfter: a past HTTP-date clamps to 0", () => {
  const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  const past = "Wed, 21 Oct 2015 07:27:00 GMT"; // -60s
  assert.equal(parseRetryAfter(past, now), 0);
});

test("parseRetryAfter: missing/empty/garbage returns null", () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("not-a-date"), null);
});

// ── rateLimitRetryDelayMs ───────────────────────────────────────────────────

test("rateLimitRetryDelayMs: 429 with Retry-After header (statusCode)", () => {
  const err = { statusCode: 429, responseHeaders: { "retry-after": "10" } };
  assert.equal(rateLimitRetryDelayMs(err), 10_000);
});

test("rateLimitRetryDelayMs: 503 honored and reads case-insensitive header", () => {
  const err = { status: 503, responseHeaders: { "Retry-After": "7" } };
  assert.equal(rateLimitRetryDelayMs(err), 7_000);
});

test("rateLimitRetryDelayMs: caps the wait at maxMs", () => {
  const err = { statusCode: 429, responseHeaders: { "retry-after": "9999" } };
  assert.equal(rateLimitRetryDelayMs(err, 60_000), 60_000);
});

test("rateLimitRetryDelayMs: 429 without Retry-After returns 0 (caller backs off)", () => {
  const err = { statusCode: 429 };
  assert.equal(rateLimitRetryDelayMs(err), 0);
});

test("rateLimitRetryDelayMs: reads a Headers-like object via get()", () => {
  const headers = new Headers({ "retry-after": "3" });
  const err = { status: 429, response: { status: 429, headers } };
  assert.equal(rateLimitRetryDelayMs(err), 3_000);
});

test("rateLimitRetryDelayMs: non-rate-limit error returns null", () => {
  assert.equal(rateLimitRetryDelayMs({ statusCode: 500 }), null);
  assert.equal(rateLimitRetryDelayMs({ message: "boom" }), null);
  assert.equal(rateLimitRetryDelayMs(new Error("network")), null);
});

test("rateLimitRetryDelayMs: detects rate limit from message text", () => {
  assert.equal(rateLimitRetryDelayMs({ message: "Rate limit exceeded" }), 0);
});

// ── extractUsage ────────────────────────────────────────────────────────────

test("extractUsage: v6 shape (inputTokens/outputTokens)", () => {
  const u = extractUsage({ usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } });
  assert.deepEqual(u, { inputTokens: 10, outputTokens: 4 });
});

test("extractUsage: legacy shape (promptTokens/completionTokens)", () => {
  const u = extractUsage({ usage: { promptTokens: 8, completionTokens: 3 } });
  assert.deepEqual(u, { inputTokens: 8, outputTokens: 3 });
});

test("extractUsage: undefined fields treated as 0", () => {
  const u = extractUsage({ usage: { inputTokens: 5, outputTokens: undefined } });
  assert.deepEqual(u, { inputTokens: 5, outputTokens: 0 });
});

test("extractUsage: no usage / all-zero returns null", () => {
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage(null), null);
  assert.equal(extractUsage({ usage: { inputTokens: 0, outputTokens: 0 } }), null);
});

// ── usage aggregation (the pattern callers use with onUsage) ─────────────────

test("usage aggregation: incremental onUsage callbacks sum to a file total", () => {
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const onUsage = (u: TokenUsage) => {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
  };

  // Simulate analysis + 2 chunks + 1 refine each reporting usage.
  for (const r of [
    { usage: { inputTokens: 100, outputTokens: 20 } },
    { usage: { inputTokens: 50, outputTokens: 30 } },
    { usage: { promptTokens: 40, completionTokens: 10 } },
    { usage: { inputTokens: 25, outputTokens: 5 } },
  ]) {
    const u = extractUsage(r);
    if (u) onUsage(u);
  }

  assert.deepEqual(total, { inputTokens: 215, outputTokens: 65 });
});
