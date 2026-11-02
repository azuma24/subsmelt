import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  parseRetryAfter,
  rateLimitRetryDelayMs,
  extractUsage,
  translateChunk,
  translateSingle,
  type TokenUsage,
} from "./ai-client.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

type ChatMessage = { content: string; reasoning_content?: string };

/**
 * Runs `fn` against a local OpenAI-compatible endpoint and returns how many
 * requests it received. "hang" accepts requests and never answers them.
 */
async function withChatServer(message: ChatMessage | "hang", fn: (apiHost: string) => Promise<void>): Promise<number> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (message === "hang") return;
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return requests;
}

function modelOpts(apiHost: string) {
  return { apiKey: "", apiHost, model: "test-model", systemPrompt: "Translate.", temperature: 0 };
}

async function translateSingleReply(message: ChatMessage): Promise<string> {
  let out = "";
  await withChatServer(message, async (apiHost) => {
    out = await translateSingle("source line", { ...modelOpts(apiHost), disableToolCalls: true });
  });
  return out;
}

// ── translateSingle: plain-text replies ─────────────────────────────────────

test("translateSingle: keeps a reply with 「」 quotes whole", async () => {
  assert.equal(await translateSingleReply({ content: "他說「我要走了」然後離開" }), "他說「我要走了」然後離開");
});

test('translateSingle: keeps a reply with "" quotes whole', async () => {
  assert.equal(await translateSingleReply({ content: 'He said "no" to her' }), 'He said "no" to her');
});

test("translateSingle: keeps both lines of a two-line reply", async () => {
  assert.equal(await translateSingleReply({ content: "Je suis\nfatigué" }), "Je suis\nfatigué");
});

test("translateSingle: keeps a dialogue-dash reply that contains quotes whole", async () => {
  assert.equal(await translateSingleReply({ content: "- 他說「好」\n- 走吧" }), "- 他說「好」\n- 走吧");
});

test("translateSingle: extracts the final answer from a reasoning-only reply", async () => {
  const reasoning = [
    "*   Source: I'm leaving.",
    "*   Target language: Traditional Chinese.",
    "Let's keep it short and natural.",
    "Final: 「我要走了」",
  ].join("\n");
  assert.equal(await translateSingleReply({ content: "", reasoning_content: reasoning }), "我要走了");
});

// ── tool-call path timeouts ─────────────────────────────────────────────────

async function timedOutToolCall(run: (apiHost: string) => Promise<unknown>) {
  let message: string | undefined;
  const requests = await withChatServer("hang", async (apiHost) => {
    message = await run(apiHost).then(
      () => "resolved",
      (error: Error) => error.message,
    );
  });
  return { requests, message };
}

test("translateChunk: a tool-call timeout surfaces without a plain-text retry", async () => {
  const outcome = await timedOutToolCall((apiHost) =>
    translateChunk(["source line"], { ...modelOpts(apiHost), requestTimeoutMs: 50 }),
  );
  assert.deepEqual(outcome, { requests: 1, message: "Request timeout after 50ms" });
});

test("translateSingle: a tool-call timeout surfaces without a plain-text retry", async () => {
  const outcome = await timedOutToolCall((apiHost) =>
    translateSingle("source line", { ...modelOpts(apiHost), requestTimeoutMs: 50 }),
  );
  assert.deepEqual(outcome, { requests: 1, message: "Request timeout after 50ms" });
});

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
  assert.deepEqual(u, {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
});

test("extractUsage: legacy shape (promptTokens/completionTokens)", () => {
  const u = extractUsage({ usage: { promptTokens: 8, completionTokens: 3 } });
  assert.deepEqual(u, { inputTokens: 8, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
});

test("extractUsage: undefined fields treated as 0", () => {
  const u = extractUsage({ usage: { inputTokens: 5, outputTokens: undefined } });
  assert.deepEqual(u, { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
});

test("extractUsage: cache and reasoning breakdowns come from the token details", () => {
  const u = extractUsage({
    usage: {
      inputTokens: 1200,
      inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 900, cacheWriteTokens: 100 },
      outputTokens: 300,
      outputTokenDetails: { textTokens: 120, reasoningTokens: 180 },
      totalTokens: 1500,
    },
  });
  assert.deepEqual(u, {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 900,
    cacheWriteTokens: 100,
    reasoningTokens: 180,
  });
});

test("extractUsage: undefined breakdown fields are 0", () => {
  const u = extractUsage({
    usage: {
      inputTokens: 7,
      inputTokenDetails: { cacheReadTokens: undefined },
      outputTokens: 2,
      outputTokenDetails: { reasoningTokens: undefined },
    },
  });
  assert.deepEqual(u, { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
});

test("extractUsage: no usage / all-zero returns null", () => {
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage(null), null);
  assert.equal(extractUsage({ usage: { inputTokens: 0, outputTokens: 0 } }), null);
});

// ── usage aggregation (the pattern callers use with onUsage) ─────────────────

test("usage aggregation: incremental onUsage callbacks sum to a file total", () => {
  const total = { inputTokens: 0, outputTokens: 0 };
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
