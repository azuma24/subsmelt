import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translateFile } from "./engine.js";

// The stubbed endpoint below trips the SDK's compatibility-mode warning on every call.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

function sourceSrt(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return `${i + 1}\n00:00:01,000 --> 00:00:01,500\ncue ${n}\n`;
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

// Verbatim shapes LM Studio returns. Both arrive as HTTP 400 "Bad Request".
function promptTooLarge(nCtx: number): Response {
  const inner = JSON.stringify({
    error: {
      code: 400,
      message: `request (12016 tokens) exceeds the available context size (${nCtx} tokens), try increasing it`,
      type: "exceed_context_size_error",
      n_prompt_tokens: 12016,
      n_ctx: nCtx,
    },
  });
  return new Response(JSON.stringify({ error: `Engine protocol predict request returned 400: ${inner}` }), { status: 400 });
}

function sharedWindowFull(): Response {
  const inner = JSON.stringify({ code: 500, message: "Context size has been exceeded.", type: "server_error" });
  return new Response(JSON.stringify({ error: `Engine protocol predict stream returned an error: ${inner}` }), { status: 400 });
}

function messageContent(body: any, role: string): string {
  const message = body.messages.find((m: any) => m.role === role);
  return typeof message?.content === "string" ? message.content : "";
}

function stubFetch(handler: (body: any) => Promise<Response> | Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
    return handler(JSON.parse(String(init?.body)));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function jobFiles(cues: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-overflow-"));
  const srtPath = path.join(dir, "Episode 01.srt");
  const outputPath = path.join(dir, "Episode 01.chi.srt");
  fs.writeFileSync(srtPath, sourceSrt(cues), "utf8");
  return { srtPath, outputPath };
}

const baseOptions = {
  apiKey: "",
  apiHost: "http://127.0.0.1:9/v1",
  model: "test-model",
  prompt: "Translate.",
  lang: "Chinese",
  additional: "",
  temperature: 0.3,
  contextSize: 0,
  requestTimeoutMs: 5_000,
  disableToolCalls: true,
};

test("chunks that overflow a shared context window are retried at lower concurrency, not per line", async () => {
  // LM Studio shares one context window across concurrent requests: two chunks
  // fit, a third concurrent one overflows. Four workers must back off to two.
  const WINDOW = 2;
  let inFlight = 0;
  let perLineRequests = 0;
  const restore = stubFetch(async (body) => {
    if (messageContent(body, "system").includes("subtitle content analyst")) return chatCompletion("Summary.");
    const user = messageContent(body, "user");
    if (user.includes("subtitle line")) perLineRequests++;
    if (inFlight >= WINDOW) return sharedWindowFull();
    inFlight++;
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    return chatCompletion(JSON.stringify(lines.map((line) => `T ${line}`)));
  });

  try {
    const { srtPath, outputPath } = jobFiles(40);
    await translateFile({ ...baseOptions, srtPath, outputPath, chunkSize: 5, parallelChunks: 4 });

    const output = fs.readFileSync(outputPath, "utf8");
    assert.equal(perLineRequests, 0);
    assert.equal((output.match(/^T cue \d{3}$/gm) ?? []).length, 40);
  } finally {
    restore();
  }
});

test("an analysis prompt that overflows the context is resent with fewer lines", async () => {
  const analysisSampleSizes: number[] = [];
  let chunkSystemPrompt = "";
  const restore = stubFetch((body) => {
    const system = messageContent(body, "system");
    const user = messageContent(body, "user");
    if (system.includes("subtitle content analyst")) {
      const sampleLines = user.split("\n").length - 1;
      analysisSampleSizes.push(sampleLines);
      return sampleLines > 60 ? promptTooLarge(1024) : chatCompletion("Summary: a test episode.");
    }
    chunkSystemPrompt = system;
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    return chatCompletion(JSON.stringify(lines.map((line) => `T ${line}`)));
  });

  try {
    const { srtPath, outputPath } = jobFiles(200);
    await translateFile({ ...baseOptions, srtPath, outputPath, prompt: "Translate. {{additional}}", chunkSize: 50, parallelChunks: 1, maxAnalysisLines: 200 });

    assert.deepEqual(analysisSampleSizes, [200, 50]);
    assert.match(chunkSystemPrompt, /Summary: a test episode\./);
  } finally {
    restore();
  }
});

test("each connection's analysis is sized to that connection's own context", async () => {
  const sampleSizeByModel = new Map<string, number>();
  const restore = stubFetch((body) => {
    const system = messageContent(body, "system");
    const user = messageContent(body, "user");
    if (system.includes("subtitle content analyst")) {
      sampleSizeByModel.set(body.model, user.split("\n").length - 1);
      // The primary is down for analysis, so the fallback connection runs it.
      return body.model === "big" ? new Response("{}", { status: 401 }) : chatCompletion("Summary.");
    }
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    return chatCompletion(JSON.stringify(lines.map((line) => `T ${line}`)));
  });

  try {
    const { srtPath, outputPath } = jobFiles(300);
    await translateFile({
      ...baseOptions,
      srtPath,
      outputPath,
      chunkSize: 100,
      parallelChunks: 1,
      llmMode: "fallback",
      connections: [
        { id: "big", label: "big", apiKey: "", apiHost: "http://127.0.0.1:9/v1", model: "big" },
        { id: "small", label: "small", apiKey: "", apiHost: "http://127.0.0.1:9/v1", model: "small" },
      ],
      analysisLinesByConnection: new Map([["big", 300], ["small", 80]]),
    });

    assert.equal(sampleSizeByModel.get("big"), 300);
    assert.equal(sampleSizeByModel.get("small"), 80);
  } finally {
    restore();
  }
});

test("parallel workers sharing one server back off on overflow instead of falling back per line", async () => {
  // Four workers over two servers: two workers share each server's window,
  // which holds one request at a time.
  const inFlightByHost = new Map<string, number>();
  let perLineRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/models")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body));
    if (messageContent(body, "system").includes("subtitle content analyst")) return chatCompletion("Summary.");
    const user = messageContent(body, "user");
    if (user.includes("subtitle line")) perLineRequests++;
    const inFlight = inFlightByHost.get(url.host) ?? 0;
    if (inFlight >= 1) return sharedWindowFull();
    inFlightByHost.set(url.host, inFlight + 1);
    await new Promise((r) => setTimeout(r, 10));
    inFlightByHost.set(url.host, (inFlightByHost.get(url.host) ?? 1) - 1);
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    return chatCompletion(JSON.stringify(lines.map((line) => `T ${line}`)));
  }) as typeof fetch;

  try {
    const { srtPath, outputPath } = jobFiles(40);
    await translateFile({
      ...baseOptions,
      srtPath,
      outputPath,
      chunkSize: 5,
      parallelChunks: 4,
      llmMode: "parallel",
      connections: [
        { id: "a", label: "a", apiKey: "", apiHost: "http://127.0.0.1:9/v1", model: "test-model" },
        { id: "b", label: "b", apiKey: "", apiHost: "http://127.0.0.2:9/v1", model: "test-model" },
      ],
    });

    const output = fs.readFileSync(outputPath, "utf8");
    assert.equal(perLineRequests, 0);
    assert.equal((output.match(/^T cue \d{3}$/gm) ?? []).length, 40);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
