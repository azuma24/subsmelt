import test from "node:test";
import assert from "node:assert/strict";
import { copyText } from "./clipboard.js";

test("copyText reports success when navigator clipboard writes", async () => {
  const calls: string[] = [];
  const clipboard = {
    writeText: async (text: string) => {
      calls.push(text);
    },
  };

  const result = await copyText("hello", { clipboard });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["hello"]);
});

test("copyText reports a failure instead of throwing when clipboard rejects", async () => {
  const clipboard = {
    writeText: async () => {
      throw new Error("permission denied");
    },
  };

  const result = await copyText("hello", { clipboard });

  assert.equal(result.ok, false);
  assert.match(result.error, /permission denied/);
});

test("copyText reports a failure when no clipboard is available", async () => {
  const result = await copyText("hello", { clipboard: undefined });

  assert.equal(result.ok, false);
  assert.match(result.error, /clipboard unavailable/i);
});
