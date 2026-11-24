import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translateFile } from "./engine.js";
import { streamable } from "./streaming-chat-fixture.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const CUE_COUNT = 40;
const CHUNK_SIZE = 5;
const REQUEST_TIMEOUT_MS = 300;
const FAST_REPLY_MS = 100;
/** Twice the request timeout: the slow chunk outlasts it while its sibling keeps finishing chunks. */
const SLOW_REPLY_MS = 600;

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

function userPrompt(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] };
  const content = body.messages.find((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : "";
}

function translationsFor(prompt: string): string {
  const lines = JSON.parse(prompt.slice(prompt.lastIndexOf("["))) as string[];
  return JSON.stringify(lines.map((line) => `T ${line}`));
}

/** Answers after `ms`, or fails like an aborted fetch if the request is aborted first. */
function replyAfter(ms: number, content: string, signal?: AbortSignal | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(chatCompletion(content)), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

test("a request silent for longer than the timeout is left to finish while the job keeps translating lines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-progress-"));
  const srtPath = path.join(dir, "Episode 01.srt");
  const outputPath = path.join(dir, "Episode 01.chi.srt");
  fs.writeFileSync(srtPath, sourceSrt(), "utf8");

  let slowChunkRequests = 0;
  const failures: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = streamable((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    const prompt = userPrompt(init);
    if (!prompt.includes("Translate the following subtitles")) return chatCompletion("Summary: a test episode.");
    const isSlowChunk = prompt.includes("cue 01");
    if (isSlowChunk) slowChunkRequests += 1;
    return replyAfter(isSlowChunk ? SLOW_REPLY_MS : FAST_REPLY_MS, translationsFor(prompt), init?.signal);
  }) as typeof fetch);

  try {
    await translateFile({
      srtPath,
      outputPath,
      connections: [
        { id: "default", label: "default", apiKey: "", apiHost: "http://127.0.0.1:9/v1", model: "test-model" },
      ],
      prompt: "Translate.",
      lang: "Chinese",
      additional: "",
      temperature: 0.3,
      chunkSize: CHUNK_SIZE,
      contextSize: 0,
      parallelChunks: 2,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      disableToolCalls: true,
      onRetry: (_attempt, error) => failures.push(String(error)),
      onConnectionError: (info) => failures.push(info.error),
    });

    assert.deepEqual(failures, [], "no request was reported as timed out");
    assert.equal(slowChunkRequests, 1, "the slow chunk was answered by its first request");
    assert.match(fs.readFileSync(outputPath, "utf8"), /T cue 01/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
