import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedConnection } from "../connections.js";
import { analyzeSubtitlesForContext } from "./context.js";
import { planJobContext } from "./context-probe.js";
import { translateFile } from "./engine.js";
import { planTranslation } from "./plan.js";
import type { TypedSettings } from "../settings-schema.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const conn = (id: string): ResolvedConnection => ({
  id,
  label: id,
  apiKey: "",
  apiHost: `http://${id}.test/v1`,
  model: "m",
});

function completion(message: object, finishReason = "stop"): Response {
  const body = {
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function stubFetch(t: { after(fn: () => void): void }, stub: typeof fetch) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = stub;
}

function lmStudioWithWindow(contextTokens: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: [{ id: "m", max_context_length: contextTokens }] }), {
      status: 200,
    })) as unknown as typeof fetch;
}

const settings = (analysisMaxLines: number) =>
  ({
    chunk_size: 20,
    parallel_chunks: 1,
    context_window: 5,
    request_timeout_s: 300,
    temperature: 0.3,
    additional_context: "",
    disable_tool_calls: true,
    refine_pass: false,
    analysis_max_lines: analysisMaxLines,
  }) as TypedSettings;

test("a 400k window does not grow the analysis sample past the setting", async (t) => {
  stubFetch(t, lmStudioWithWindow(400_000));
  const plan = await planTranslation([conn("a")], settings(500));
  assert.equal(plan.options.analysisLinesByConnection.get("a"), 500);
});

test("a small window still limits the sample below the setting", async (t) => {
  stubFetch(t, lmStudioWithWindow(8_000));
  const plan = await planTranslation([conn("a")], settings(500));
  assert.equal(plan.options.analysisLinesByConnection.get("a"), 106);
});

test("the owner can raise the sample as far as the window allows", async (t) => {
  stubFetch(t, lmStudioWithWindow(400_000));
  const plan = await planTranslation([conn("a")], settings(5000));
  assert.equal(plan.options.analysisLinesByConnection.get("a"), 5000);
});

test("silent hosts are probed together, not one timeout after another", async (t) => {
  let inFlight = 0;
  let peak = 0;
  stubFetch(t, (async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch);
  await planJobContext([conn("a"), conn("b"), conn("c")], { chunkSize: 20, configuredParallel: 1 });
  assert.equal(peak, 3);
});

async function analysisOf(
  t: { after(fn: () => void): void },
  reply: Response,
  seen: { body?: { max_tokens?: number } },
) {
  stubFetch(t, (async (_: string, init: RequestInit) => {
    seen.body = JSON.parse(String(init.body));
    return reply;
  }) as unknown as typeof fetch);
  return analyzeSubtitlesForContext(["hello"], {
    apiKey: "",
    apiHost: "http://a.test/v1",
    model: "m",
    lang: "Chinese",
  });
}

test("the analysis request limits its output", async (t) => {
  const seen: { body?: { max_tokens?: number } } = {};
  assert.equal(await analysisOf(t, completion({ content: "Summary." }), seen), "Summary.");
  assert.equal(seen.body?.max_tokens, 6000);
});

test("a model cut off while reasoning yields no analysis, not its reasoning", async (t) => {
  const reply = completion({ content: "", reasoning_content: "Let me think about this..." }, "length");
  assert.equal(await analysisOf(t, reply, {}), "");
});

test("a reply cut off after the answer started keeps that text", async (t) => {
  const partial = "### Plot Summary\nPartial";
  assert.equal(await analysisOf(t, completion({ content: partial }, "length"), {}), partial);
});

for (const reasoning of ["<think>\nLet me think about the plot...", "Thinking Process:\n1. Analyze..."]) {
  test(`reasoning cut off inside the text is not an analysis: ${reasoning.slice(0, 8)}`, async (t) => {
    assert.equal(await analysisOf(t, completion({ content: reasoning }, "length"), {}), "");
  });
}

test("a cut-off analysis still records the tokens it used", async (t) => {
  stubFetch(t, (async () => completion({ content: "" }, "length")) as unknown as typeof fetch);
  const usage: { inputTokens: number; outputTokens: number }[] = [];
  await analyzeSubtitlesForContext(["hello"], {
    apiKey: "",
    apiHost: "http://a.test/v1",
    model: "m",
    lang: "Chinese",
    onUsage: (u) => usage.push(u),
  });
  assert.deepEqual([usage[0]?.inputTokens, usage[0]?.outputTokens], [1, 1]);
});

test("the analysis phase ends when a stop lands during the call", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-start-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srtPath = path.join(dir, "in.srt");
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\nhello\n", "utf8");
  const controller = new AbortController();
  stubFetch(t, ((input: string, init: RequestInit) => {
    if (String(input).endsWith("/models")) return Promise.resolve(new Response("{}", { status: 200 }));
    setTimeout(() => controller.abort("stop_requested"), 1);
    return new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch);
  const phases: boolean[] = [];
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
      connections: [conn("a")],
      abortSignal: controller.signal,
      onAnalysisPhase: (running) => phases.push(running),
    }),
    /STOP_REQUESTED/,
  );
  assert.deepEqual(phases, [true, false]);
});

test("the analysis phase is reported around the analysis call, even when it fails", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-start-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srtPath = path.join(dir, "in.srt");
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\nhello\n", "utf8");
  const events: string[] = [];
  stubFetch(t, (async (input: string, init: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    const system = String(JSON.parse(String(init.body)).messages[0].content);
    if (system.includes("subtitle content analyst")) {
      events.push("analysis request");
      return new Response('{"error":"bad"}', { status: 400 });
    }
    events.push("chunk request");
    return completion({ content: '["Z"]' });
  }) as unknown as typeof fetch);
  await translateFile({
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
    connections: [conn("a")],
    onAnalysisPhase: (running) => events.push(running ? "phase on" : "phase off"),
  });
  assert.deepEqual(events, ["phase on", "analysis request", "phase off", "chunk request"]);
});
