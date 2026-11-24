import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translateFile } from "./engine.js";
import { streamable } from "./streaming-chat-fixture.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const CUE_COUNT = 10;
const CHUNK_SIZE = 5;

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

interface ChatRequest {
  max_tokens?: number;
  messages: { role: string; content: unknown }[];
}

function userPrompt(request: ChatRequest): string {
  const content = request.messages.find((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : "";
}

function sourceLines(prompt: string): string[] {
  return JSON.parse(prompt.slice(prompt.lastIndexOf("["))) as string[];
}

/** Translates the file against a fake server and returns the chunk and per-line requests it received. */
async function translateAgainst(replyTo: (lines: string[], requestNumber: number) => string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-runaway-"));
  const srtPath = path.join(dir, "Episode 01.srt");
  const outputPath = path.join(dir, "Episode 01.chi.srt");
  fs.writeFileSync(srtPath, sourceSrt(), "utf8");

  const chunkRequests: ChatRequest[] = [];
  const lineRequests: ChatRequest[] = [];
  const progress: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = streamable((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    const prompt = userPrompt(request);
    if (prompt.includes("Translate the following subtitle line")) {
      lineRequests.push(request);
      return chatCompletion("T line");
    }
    if (!prompt.includes("Translate the following subtitles")) return chatCompletion("Summary: a test episode.");
    chunkRequests.push(request);
    return chatCompletion(JSON.stringify(replyTo(sourceLines(prompt), chunkRequests.length)));
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
      parallelChunks: 1,
      requestTimeoutMs: 5_000,
      disableToolCalls: true,
      onProgress: (completed) => progress.push(completed),
    });
    return { chunkRequests, lineRequests, progress, output: fs.readFileSync(outputPath, "utf8") };
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const translated = (lines: string[]) => lines.map((line) => `T ${line}`);

test("a chunk answered with the wrong number of lines is asked again before falling back to single lines", async () => {
  const { chunkRequests, lineRequests, output } = await translateAgainst((lines, requestNumber) =>
    requestNumber === 1 ? [...translated(lines), "one line too many"] : translated(lines),
  );

  assert.equal(lineRequests.length, 0, "no line was translated on its own");
  assert.equal(chunkRequests.length, 3, "the first chunk twice, the second once");
  assert.match(output, /T cue 01/);
});

test("a chunk request to a self-hosted server limits the length of the reply", async () => {
  const { chunkRequests } = await translateAgainst(translated);

  for (const request of chunkRequests) {
    assert.ok((request.max_tokens ?? 0) > 0, `max_tokens is ${request.max_tokens}`);
  }
});

test("lines translated one at a time are counted as each one is done", async () => {
  const { progress } = await translateAgainst((lines, requestNumber) =>
    requestNumber <= 2 ? [...translated(lines), "one line too many"] : translated(lines),
  );

  assert.deepEqual([...new Set(progress)], [0, 1, 2, 3, 4, 5, 10]);
});
