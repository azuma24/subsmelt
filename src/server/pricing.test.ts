import test from "node:test";
import assert from "node:assert/strict";
import { estimateCost, lookupModelPrice, MODEL_PRICES } from "./pricing.js";

// ── lookupModelPrice ─────────────────────────────────────────────────────────

test("lookupModelPrice: exact id match", () => {
  assert.deepEqual(lookupModelPrice("gpt-4o-mini"), MODEL_PRICES["gpt-4o-mini"]);
  assert.deepEqual(lookupModelPrice("claude-3-5-sonnet"), MODEL_PRICES["claude-3-5-sonnet"]);
});

test("lookupModelPrice: case-insensitive", () => {
  assert.deepEqual(lookupModelPrice("GPT-4o"), MODEL_PRICES["gpt-4o"]);
});

test("lookupModelPrice: dated/suffixed ids resolve via substring", () => {
  assert.deepEqual(lookupModelPrice("gpt-4o-2024-08-06"), MODEL_PRICES["gpt-4o"]);
  assert.deepEqual(lookupModelPrice("claude-3-5-sonnet-20241022"), MODEL_PRICES["claude-3-5-sonnet"]);
});

test("lookupModelPrice: longest match wins (mini beats base)", () => {
  // "gpt-4o-mini-2024" contains both "gpt-4o" and "gpt-4o-mini" — the longer key must win.
  assert.deepEqual(lookupModelPrice("gpt-4o-mini-2024-07-18"), MODEL_PRICES["gpt-4o-mini"]);
});

test("lookupModelPrice: gemini models/ prefix is stripped", () => {
  assert.deepEqual(lookupModelPrice("models/gemini-2.5-flash"), MODEL_PRICES["gemini-2.5-flash"]);
});

test("lookupModelPrice: unknown / empty / null → null", () => {
  assert.equal(lookupModelPrice("Qwen/Qwen2.5-72B-Instruct"), null);
  assert.equal(lookupModelPrice("llama-3-8b"), null);
  assert.equal(lookupModelPrice(""), null);
  assert.equal(lookupModelPrice(null), null);
  assert.equal(lookupModelPrice(undefined), null);
});

// ── estimateCost ─────────────────────────────────────────────────────────────

test("estimateCost: priced model computes USD from per-1M rates", () => {
  // gpt-4o = $2.5/1M in, $10/1M out
  const cost = estimateCost("gpt-4o", 1_000_000, 1_000_000);
  assert.equal(cost, 12.5);
});

test("estimateCost: fractional token counts scale linearly", () => {
  // gpt-4o-mini = $0.15/1M in, $0.6/1M out
  const cost = estimateCost("gpt-4o-mini", 500_000, 250_000);
  assert.ok(cost !== null);
  assert.ok(Math.abs((cost as number) - (0.075 + 0.15)) < 1e-9);
});

test("estimateCost: unknown/local model → null (tokens still tracked elsewhere)", () => {
  assert.equal(estimateCost("Qwen/Qwen2.5-72B-Instruct", 100_000, 50_000), null);
  assert.equal(estimateCost("", 100, 100), null);
});

test("estimateCost: zero tokens on a known model is $0", () => {
  assert.equal(estimateCost("gpt-4o", 0, 0), 0);
});

test("estimateCost: negative / non-finite token counts are clamped to 0", () => {
  assert.equal(estimateCost("gpt-4o", -100, -100), 0);
  assert.equal(estimateCost("gpt-4o", Number.NaN, Number.POSITIVE_INFINITY), 0);
});
