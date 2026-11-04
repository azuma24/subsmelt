import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retryTranslate } from "./ai-client.js";
import { translateFile } from "./engine.js";
import type { ResolvedConnection } from "../connections.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const LONG_BACKOFF_MS = 30_000;
const PROMPT_MS = 2_000;

function alwaysRetryable(): Promise<never> {
  return Promise.reject(new Error("fetch failed"));
}

test("a stop during a retry backoff ends the wait at once", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort("stop_requested"), 20);
  await assert.rejects(
    retryTranslate(alwaysRetryable, 2, LONG_BACKOFF_MS, undefined, controller.signal),
    /^Error: STOP_REQUESTED$/,
  );
  assert.ok(Date.now() - started < PROMPT_MS);
});

test("a cancel during a retry backoff keeps its identity", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("JOB_CANCELLED")), 20);
  await assert.rejects(
    retryTranslate(alwaysRetryable, 2, LONG_BACKOFF_MS, undefined, controller.signal),
    /^Error: JOB_CANCELLED$/,
  );
});

test("a backoff with no abort still retries", async () => {
  let calls = 0;
  const result = await retryTranslate(
    () => {
      calls += 1;
      return calls === 1 ? alwaysRetryable() : Promise.resolve("ok");
    },
    2,
    1,
    undefined,
    new AbortController().signal,
  );
  assert.deepEqual([result, calls], ["ok", 2]);
});

test("stopping a file whose chunk is waiting out a Retry-After ends at once", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-backoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srtPath = path.join(dir, "in.srt");
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\nhello\n", "utf8");

  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    setTimeout(() => controller.abort("stop_requested"), 20);
    return new Response('{"error":"slow down"}', { status: 429, headers: { "retry-after": "30" } });
  }) as typeof fetch;

  const connection: ResolvedConnection = {
    id: "a",
    label: "A",
    apiKey: "",
    apiHost: "http://a.test/v1",
    model: "m",
    provider: undefined,
  } as ResolvedConnection;
  const started = Date.now();
  await assert.rejects(
    translateFile({
      srtPath,
      outputPath: path.join(dir, "out.srt"),
      prompt: "",
      lang: "Chinese",
      additional: "",
      temperature: 0.3,
      chunkSize: 20,
      contextSize: 0,
      parallelChunks: 1,
      disableToolCalls: true,
      connections: [connection],
      abortSignal: controller.signal,
    }),
    /STOP_REQUESTED/,
  );
  assert.ok(Date.now() - started < PROMPT_MS, `took ${Date.now() - started}ms`);
});
