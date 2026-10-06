import test from "node:test";
import assert from "node:assert/strict";
import { flag, num, str } from "./settings-value.js";

test("str returns strings and falls back on anything else", () => {
  assert.equal(str("srt"), "srt");
  assert.equal(str("", "srt"), "", "an empty string is a real value, not a miss");
  assert.equal(str(undefined, "srt"), "srt");
  assert.equal(str(null, "srt"), "srt");
  assert.equal(str(42, "srt"), "srt");
  assert.equal(str(undefined), "");
});

test("num parses stored strings and rejects junk", () => {
  assert.equal(num("300", 60), 300);
  assert.equal(num("1.5", 0), 1.5);
  assert.equal(num(7, 0), 7);
  assert.equal(num("not a number", 60), 60);
  assert.equal(num(undefined, 60), 60);
  assert.equal(num(Number.NaN, 60), 60);
});

test("flag treats the server's \"1\" as true and everything else as false", () => {
  assert.equal(flag("1"), true);
  assert.equal(flag("0"), false);
  // The server writes "1"/"0"; any other string is not a truthy flag.
  assert.equal(flag("yes"), false);
  assert.equal(flag(true), true);
  assert.equal(flag(undefined), false);
  assert.equal(flag(undefined, true), true);
});
