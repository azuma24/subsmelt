import test from "node:test";
import assert from "node:assert/strict";
import { translateChunk, translateSingle, type TokenUsage } from "./ai-client.js";
import { analyzeSubtitlesForContext } from "./context.js";
import { streamable } from "./streaming-chat-fixture.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

interface ChatRequest {
  reasoning_effort?: string;
}

function chatCompletion(content: string, finishReason: string): Response {
  const body = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * A model that reasons until the output limit unless the request asks for
 * `effort`, in which case it answers. Returns the requests it received.
 */
async function againstReasoningModel(effort: string, answer: string, fn: () => Promise<void>): Promise<ChatRequest[]> {
  const requests: ChatRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = streamable((async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    requests.push(request);
    return request.reasoning_effort === effort ? chatCompletion(answer, "stop") : chatCompletion("", "length");
  }) as typeof fetch);
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return requests;
}

const CONNECTION = {
  apiKey: "",
  apiHost: "http://127.0.0.1:9/v1",
  model: "test-model",
  systemPrompt: "Translate.",
  temperature: 0.3,
  disableToolCalls: true,
  requestTimeoutMs: 5_000,
};

test("a cut-off chunk is asked for again on the same connection at the retry effort", async () => {
  const usage: TokenUsage[] = [];
  let translated: string[] = [];
  const requests = await againstReasoningModel("low", '["T one","T two"]', async () => {
    translated = await translateChunk(["one", "two"], {
      ...CONNECTION,
      cutOffRetryEffort: "low",
      onUsage: (u) => usage.push(u),
    });
  });

  assert.deepEqual(translated, ["T one", "T two"]);
  assert.deepEqual(
    requests.map((request) => request.reasoning_effort),
    [undefined, "low"],
  );
  assert.equal(usage.length, 2, "the cut-off attempt's tokens are counted too");
});

test("a cut-off chunk fails as before when the connection has no retry effort", async () => {
  const requests = await againstReasoningModel("low", '["T one","T two"]', async () => {
    await assert.rejects(translateChunk(["one", "two"], CONNECTION), /finish reason: length/);
  });

  assert.deepEqual(
    requests.map((request) => request.reasoning_effort),
    [undefined],
  );
});

test("a cut-off single line is asked for again at the retry effort", async () => {
  let translated = "";
  const requests = await againstReasoningModel("low", "T one", async () => {
    translated = await translateSingle("one", { ...CONNECTION, cutOffRetryEffort: "low" });
  });

  assert.equal(translated, "T one");
  assert.deepEqual(
    requests.map((request) => request.reasoning_effort),
    [undefined, "low"],
  );
});

test("a cut-off context analysis is asked for again at the retry effort", async () => {
  const analysisText = "### 📝 Plot Summary\nA test episode.\n\n### 📚 Glossary\n- term: Ned | description: a lord";
  let analysis = "";
  const requests = await againstReasoningModel("low", analysisText, async () => {
    analysis = await analyzeSubtitlesForContext(["one", "two"], {
      apiKey: "",
      apiHost: "http://127.0.0.1:9/v1",
      model: "test-model",
      lang: "Chinese",
      requestTimeoutMs: 5_000,
      cutOffRetryEffort: "low",
    });
  });

  assert.equal(analysis, analysisText);
  assert.deepEqual(
    requests.map((request) => request.reasoning_effort),
    [undefined, "low"],
  );
});
