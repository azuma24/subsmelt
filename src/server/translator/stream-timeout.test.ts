import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { STREAM_TOTAL_TIMEOUT_FACTOR, isTransportFailure, streamReply } from "./ai-client.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const IDLE_MS = 100;
const GAP_MS = 50;
const STEP_MS = 10;

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer PART> ? PART : never;

const FINISH: StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
};

/** Settles like an aborted fetch does: with the abort reason, as soon as the request is aborted. */
function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

/**
 * A model that emits one text delta every GAP_MS. After `deltas` of them it
 * either finishes the reply or goes silent with the stream still open.
 */
function modelEmitting(deltas: number, then: "finish" | "silence"): MockLanguageModelV4 {
  let sent = 0;
  const streamFor = (signal?: AbortSignal) =>
    new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
      async pull(controller) {
        if (signal?.aborted) return;
        if (sent === deltas && then === "silence") return untilAborted(signal).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, GAP_MS));
        if (signal?.aborted) return;
        if (sent < deltas) {
          controller.enqueue({ type: "text-delta", id: "t", delta: `w${sent++} ` });
          return;
        }
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue(FINISH);
        controller.close();
      },
    });
  return new MockLanguageModelV4({ doStream: async ({ abortSignal }) => ({ stream: streamFor(abortSignal) }) });
}

/** Starts a reply under fake timers and reports how it ended and at what virtual time. */
async function replyOutcome(model: MockLanguageModelV4, runForMs: number) {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let elapsedMs = 0;
    let outcome: { text?: string; error?: unknown; atMs: number } | undefined;
    streamReply({ model, temperature: 0, system: "Translate.", prompt: "hello" }, IDLE_MS).then(
      (step) => {
        outcome = { text: step.text, atMs: elapsedMs };
      },
      (error: unknown) => {
        outcome = { error, atMs: elapsedMs };
      },
    );
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    await settle();
    while (!outcome && elapsedMs < runForMs) {
      mock.timers.tick(STEP_MS);
      elapsedMs += STEP_MS;
      await settle();
    }
    return outcome;
  } finally {
    mock.timers.reset();
  }
}

test("a reply that keeps arriving for longer than the idle timeout completes", async () => {
  const outcome = await replyOutcome(modelEmitting(4, "finish"), 1_000);

  assert.equal(outcome?.error, undefined);
  assert.equal(outcome?.text, "w0 w1 w2 w3 ");
  assert.ok((outcome?.atMs ?? 0) > IDLE_MS, `finished at ${outcome?.atMs}ms, past the ${IDLE_MS}ms idle timeout`);
});

test("a reply that goes silent fails one idle timeout after its last part", async () => {
  const outcome = await replyOutcome(modelEmitting(2, "silence"), 1_000);

  assert.match(String(outcome?.error), /Request timeout: no output for 100ms/);
  assert.equal(isTransportFailure(outcome?.error), true, "counts toward the connection breaker");
  assert.equal(outcome?.atMs, 2 * GAP_MS + IDLE_MS);
});

test("a model that never answers fails after the idle timeout", async () => {
  const model = new MockLanguageModelV4({ doStream: ({ abortSignal }) => untilAborted(abortSignal) });
  const outcome = await replyOutcome(model, 1_000);

  assert.match(String(outcome?.error), /Request timeout: no output for 100ms/);
  assert.equal(outcome?.atMs, IDLE_MS);
});

test("a reply that never stops arriving fails at the total limit", async () => {
  const outcome = await replyOutcome(modelEmitting(Number.POSITIVE_INFINITY, "finish"), 1_000);

  assert.match(String(outcome?.error), /Request timeout: reply still unfinished at the 300ms total limit/);
  assert.equal(isTransportFailure(outcome?.error), true);
  assert.equal(outcome?.atMs, IDLE_MS * STREAM_TOTAL_TIMEOUT_FACTOR);
});
