import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PARTIAL_SUFFIX,
  partialOutputPath,
  removePartialOutput,
  resolveTranslatedOutputPath,
  translateFile,
} from "./engine.js";
import { retryTranslate } from "./ai-client.js";

// The stubbed endpoint below trips the SDK's compatibility-mode warning on every call.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const CUE_COUNT = 40;
const CHUNK_SIZE = 5;
const WORKERS = 4;

function sourceSrt(): string {
  return Array.from({ length: CUE_COUNT }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return `${i + 1}\n00:00:${n},000 --> 00:00:${n},500\ncue ${n}\n`;
  }).join("\n");
}

function chatCompletion(content: string): Response {
  const body = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** The chunk payload is the JSON array at the end of the user prompt. */
function translationsFor(userPrompt: string): string[] {
  const lines = JSON.parse(userPrompt.slice(userPrompt.lastIndexOf("["))) as string[];
  return lines.map((line) => `T ${line}`);
}

function messageContent(body: any, role: string): string {
  const message = body.messages.find((m: any) => m.role === role);
  return typeof message?.content === "string" ? message.content : "";
}

test("a failed chunk worker stops its siblings from calling the LLM and rewriting the partial", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-abort-"));
  const srtPath = path.join(dir, "Episode 01.srt");
  const outputPath = path.join(dir, "Episode 01.chi.srt");
  fs.writeFileSync(srtPath, sourceSrt(), "utf8");

  const chunkPrompts: string[] = [];
  const release: Array<() => void> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body));
    if (messageContent(body, "system").includes("subtitle content analyst")) {
      return chatCompletion("Summary: a test episode.");
    }
    const user = messageContent(body, "user");
    chunkPrompts.push(user);
    // The first chunk (and its per-line fallback) fails with a permanent error.
    if (/cue 0[1-5]/.test(user)) {
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 });
    }
    // Every other chunk stays in flight until the test releases it, or until the
    // engine aborts it.
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
      release.push(() => resolve(chatCompletion(JSON.stringify(translationsFor(user)))));
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      translateFile({
        srtPath,
        outputPath,
        apiKey: "",
        apiHost: "http://127.0.0.1:9/v1",
        model: "test-model",
        prompt: "Translate.",
        lang: "Chinese",
        additional: "",
        temperature: 0.3,
        chunkSize: CHUNK_SIZE,
        contextSize: 0,
        parallelChunks: WORKERS,
        requestTimeoutMs: 5_000,
        disableToolCalls: true,
      }),
      /Per-line fallback aborted after 3 consecutive failures/,
    );

    // Let any sibling still running answer its in-flight request and carry on.
    for (const respond of release.splice(0)) respond();
    await new Promise((r) => setTimeout(r, 150));
    for (const respond of release.splice(0)) respond();
    await new Promise((r) => setTimeout(r, 150));

    // One chunk request per worker, plus the three per-line calls that failed
    // the job. Siblings that kept going would have requested further chunks.
    assert.equal(chunkPrompts.length, WORKERS + 3);
    assert.equal(fs.existsSync(partialOutputPath(outputPath)), false, "no sibling may write the partial after the job failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("partial translations are written beside the output, not onto it", () => {
  const output = "/media/show/Episode 01.chi.srt";
  const partial = partialOutputPath(output);

  assert.equal(partial, `${output}${PARTIAL_SUFFIX}`);
  assert.notEqual(partial, output);
  // The queue skips a job when its output_path already exists, so an in-flight
  // translation must never occupy that path — that is what made interrupted
  // jobs come back as "output already exists" with a truncated file.
  assert.ok(partial.startsWith(output));
});

test("preview prefers the in-flight partial over a missing finished file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-preview-"));
  const output = path.join(dir, "Episode 01.chi.srt");
  const partial = partialOutputPath(output);
  fs.writeFileSync(partial, "1\n00:00:00,000 --> 00:00:01,000\n你好\n", "utf8");
  assert.equal(resolveTranslatedOutputPath(output), partial);
  fs.writeFileSync(output, "finished", "utf8");
  fs.rmSync(partial);
  assert.equal(resolveTranslatedOutputPath(output), output);
});

test("renaming a partial onto the output is atomic and leaves no partial behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-partial-"));
  const output = path.join(dir, "Episode 01.chi.srt");
  const partial = partialOutputPath(output);

  fs.writeFileSync(partial, "partial content", "utf8");
  assert.equal(fs.existsSync(output), false, "output must not exist mid-run");

  fs.renameSync(partial, output);

  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.readFileSync(output, "utf8"), "partial content");
});

test("removing a job's partial leaves a finished output alone and tolerates a missing partial", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-rm-partial-"));
  const output = path.join(dir, "Episode 01.chi.srt");
  const partial = partialOutputPath(output);
  fs.writeFileSync(partial, "half done", "utf8");
  fs.writeFileSync(output, "finished", "utf8");
  assert.equal(fs.existsSync(partial), true);

  removePartialOutput(output);
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.readFileSync(output, "utf8"), "finished");

  removePartialOutput(output);
  assert.equal(fs.readFileSync(output, "utf8"), "finished");
});

test("retryTranslate reports the real attempt budget to onRetry", async () => {
  const seen: Array<{ attempt: number; max?: number }> = [];

  await assert.rejects(
    retryTranslate(
      async () => {
        throw new Error("timeout");
      },
      2,
      1,
      (attempt, _error, _backoff, maxRetries) => seen.push({ attempt, max: maxRetries }),
    ),
  );

  // Two attempts total: the first reports a retry, the second throws. The
  // reported max must be the real budget — the queue log used to hardcode "/5".
  assert.deepEqual(seen, [{ attempt: 1, max: 2 }]);
});

test("retryTranslate stops immediately on a non-retryable error", async () => {
  let calls = 0;

  await assert.rejects(
    retryTranslate(
      async () => {
        calls += 1;
        const error: any = new Error("invalid api key");
        error.status = 401;
        throw error;
      },
      5,
      1,
    ),
  );

  assert.equal(calls, 1);
});
