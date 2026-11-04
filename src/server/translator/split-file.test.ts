import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedConnection } from "../connections.js";
import { type TranslateFileOptions, translateFile } from "./engine.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const FAST = { pollMs: 2, minWaitMs: 30, noHistoryWaitMs: 30 };

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

const rejected = () => new Response('{"error":"bad request"}', { status: 400 });

interface Call {
  host: string;
  kind: "chunk" | "line";
  lines: string[];
  signal?: AbortSignal | null;
}

const hang = (signal?: AbortSignal | null) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
      once: true,
    });
  });

function useFetch(t: { after(fn: () => void): void }, chat: (call: Call) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/models")) return new Response('{"data":[]}', { status: 200 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const system = String(body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "");
    if (system.includes("subtitle content analyst")) return chatCompletion("Summary.");
    const user = String(body.messages?.findLast((m: { role: string }) => m.role === "user")?.content ?? "");
    const at = user.lastIndexOf("[");
    let parsed: string[] | null = null;
    try {
      parsed = at >= 0 ? JSON.parse(user.slice(at)) : null;
    } catch {
      parsed = null;
    }
    const call: Call = parsed
      ? { host: url.hostname, kind: "chunk", lines: parsed, signal: init?.signal }
      : { host: url.hostname, kind: "line", lines: [user.trim()], signal: init?.signal };
    calls.push(call);
    return chat(call);
  }) as typeof fetch;
  return calls;
}

const answer = (tag: string, lines: string[]) => chatCompletion(JSON.stringify(lines.map((l) => `${tag}-${l}`)));
const conn = (id: string): ResolvedConnection => ({
  id,
  label: id,
  apiKey: "",
  apiHost: `http://${id}.test/v1`,
  model: "m",
});

async function translate(
  t: { after(fn: () => void): void },
  cues: number,
  chunkSize: number,
  connections: ResolvedConnection[],
  extra: Partial<TranslateFileOptions> = {},
): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-split-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srtPath = path.join(dir, "in.srt");
  const outputPath = path.join(dir, "out.srt");
  fs.writeFileSync(
    srtPath,
    Array.from({ length: cues }, (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:01,500\ncue ${i + 1}\n`).join("\n"),
    "utf8",
  );
  await translateFile({
    srtPath,
    outputPath,
    prompt: "Translate.",
    lang: "Chinese",
    additional: "",
    temperature: 0.3,
    contextSize: 0,
    chunkSize,
    parallelChunks: 1,
    requestTimeoutMs: 300_000,
    disableToolCalls: true,
    connections,
    llmMode: "parallel",
    split: { limits: new Map(connections.map((c) => [c.id, 1])), hedgeTiming: FAST },
    ...extra,
  });
  return fs
    .readFileSync(outputPath, "utf8")
    .trim()
    .split(/\n\n+/)
    .map((cue) => cue.split("\n").slice(2).join("\n").trim());
}

test("without a split option a slow chunk is requested once", async (t) => {
  const calls = useFetch(t, async (call) => {
    if (call.lines.includes("cue 2")) await new Promise((r) => setTimeout(r, 150));
    return answer("A", call.lines);
  });
  const texts = await translate(t, 2, 1, [conn("a"), conn("b")], { split: undefined });
  assert.deepEqual(texts, ["A-cue 1", "A-cue 2"]);
  assert.equal(calls.filter((c) => c.lines.includes("cue 2")).length, 1);
});

test("the original wins when it answers after a duplicate started", async (t) => {
  let answerOriginal: () => void = () => {};
  const stuck: Call[] = [];
  useFetch(t, (call) => {
    if (!call.lines.includes("cue 2")) return answer("Q", call.lines);
    stuck.push(call);
    if (stuck.length === 2) {
      setTimeout(() => answerOriginal(), 5);
      return hang(call.signal);
    }
    return new Promise<Response>((resolve) => {
      answerOriginal = () => resolve(answer("ORIGINAL", call.lines));
    });
  });
  const texts = await translate(t, 2, 1, [conn("a"), conn("b")]);
  assert.equal(texts[1], "ORIGINAL-cue 2");
  assert.equal(stuck.length, 2);
  assert.equal(stuck[1].signal?.aborted, true, "the duplicate was terminated");
});

test("a duplicate that fails straight away leaves the original's answer", async (t) => {
  let answerOriginal: () => void = () => {};
  let seen = 0;
  useFetch(t, (call) => {
    if (!call.lines.includes("cue 2")) return answer("Q", call.lines);
    seen += 1;
    if (seen === 2) {
      setTimeout(() => answerOriginal(), 5);
      return rejected();
    }
    return new Promise<Response>((resolve) => {
      answerOriginal = () => resolve(answer("ORIGINAL", call.lines));
    });
  });
  const texts = await translate(t, 2, 1, [conn("a"), conn("b")]);
  assert.equal(texts[1], "ORIGINAL-cue 2");
});

test("a one-chunk file stalled with nothing finished still gets a duplicate", async (t) => {
  useFetch(t, (call) => (call.host === "a.test" ? hang(call.signal) : answer("B", call.lines)));
  assert.deepEqual(await translate(t, 1, 1, [conn("a"), conn("b")]), ["B-cue 1"]);
});

test("an original that fails hears out its duplicate before any per-line fallback", async (t) => {
  let failOriginal: (r: Response) => void = () => {};
  const calls = useFetch(t, (call) => {
    if (call.kind === "line") return chatCompletion("L");
    if (call.host === "a.test") {
      return new Promise<Response>((resolve) => {
        failOriginal = resolve;
      });
    }
    failOriginal(rejected());
    return new Promise<Response>((resolve) => setTimeout(() => resolve(answer("B", call.lines)), 30));
  });
  // b has a free slot, so only the skip keeps the failed original off it.
  const texts = await translate(t, 4, 4, [conn("a"), conn("b")], {
    split: {
      limits: new Map([
        ["a", 1],
        ["b", 2],
      ]),
      hedgeTiming: FAST,
    },
  });
  assert.deepEqual(texts, ["B-cue 1", "B-cue 2", "B-cue 3", "B-cue 4"]);
  assert.equal(calls.filter((c) => c.kind === "line").length, 0);
  assert.deepEqual(
    calls.map((c) => c.host),
    ["a.test", "b.test"],
    "the failed original must not send a second request to its duplicate's host",
  );
});

/**
 * The chunk fails on all three hosts, then the per-line fallback hangs on its
 * second line until the duplicate (on a, the first host free to try again) has
 * started. Every other line outcome comes from `line`, and the duplicate answers
 * only after `lastLine` has been tried on the last host.
 */
function useFailedChunkWithLateDuplicate(
  t: { after(fn: () => void): void },
  lastLine: string,
  line: (text: string) => Response,
) {
  let freeLine: (r: Response) => void = () => {};
  let chunksOnA = 0;
  let answerDuplicate: () => void = () => {};
  return useFetch(t, (call) => {
    if (call.kind === "chunk") {
      if (call.host !== "a.test") return rejected();
      chunksOnA += 1;
      if (chunksOnA === 1) return rejected();
      setTimeout(() => freeLine(rejected()), 5);
      return new Promise<Response>((resolve) => {
        answerDuplicate = () => resolve(answer("DUP", call.lines));
      });
    }
    if (call.host === "a.test" && call.lines[0].includes("cue 2")) {
      return new Promise<Response>((resolve) => {
        freeLine = resolve;
      });
    }
    if (call.host === "c.test" && call.lines[0].includes(lastLine)) setTimeout(() => answerDuplicate(), 5);
    return line(call.lines[0]);
  });
}

const threeHostSplit = {
  limits: new Map([
    ["a", 2],
    ["b", 1],
    ["c", 1],
  ]),
  hedgeTiming: FAST,
};

test("a partial per-line result does not end a duplicate that can answer every line", async (t) => {
  useFailedChunkWithLateDuplicate(t, "cue 4", (text) => (/cue [13]/.test(text) ? chatCompletion("LINE") : rejected()));
  const texts = await translate(t, 4, 4, [conn("a"), conn("b"), conn("c")], { split: threeHostSplit });
  assert.deepEqual(texts, ["DUP-cue 1", "DUP-cue 2", "DUP-cue 3", "DUP-cue 4"]);
});

test("a duplicate can save a chunk whose original fails outright", async (t) => {
  useFailedChunkWithLateDuplicate(t, "cue 3", () => rejected());
  const texts = await translate(t, 4, 4, [conn("a"), conn("b"), conn("c")], { split: threeHostSplit });
  assert.deepEqual(texts, ["DUP-cue 1", "DUP-cue 2", "DUP-cue 3", "DUP-cue 4"]);
});

test("a real failure after a win still fails the job", async (t) => {
  useFetch(t, (call) => answer("A", call.lines));
  let ticks = 0;
  await assert.rejects(
    translate(t, 2, 1, [conn("a"), conn("b")], {
      onProgress: () => {
        ticks += 1;
        if (ticks > 1) throw new Error("disk full");
      },
    }),
    /disk full/,
  );
});

test("a terminated request does not count against its machine", async (t) => {
  const dropped: string[] = [];
  useFetch(t, (call) => {
    if (call.host === "a.test") return hang(call.signal);
    return answer("B", call.lines);
  });
  const texts = await translate(t, 6, 1, [conn("a"), conn("b")], {
    split: {
      limits: new Map([
        ["a", 3],
        ["b", 3],
      ]),
      hedgeTiming: FAST,
    },
    onConnectionDropped: ({ id }) => dropped.push(id),
  });
  assert.deepEqual(dropped, [], "three terminated requests on a must not trip its breaker");
  assert.deepEqual(texts, ["B-cue 1", "B-cue 2", "B-cue 3", "B-cue 4", "B-cue 5", "B-cue 6"]);
});

test("each connection is held to its own limit", async (t) => {
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  useFetch(t, async (call) => {
    const now = (inFlight.get(call.host) ?? 0) + 1;
    inFlight.set(call.host, now);
    peak.set(call.host, Math.max(peak.get(call.host) ?? 0, now));
    await new Promise((r) => setTimeout(r, 15));
    inFlight.set(call.host, (inFlight.get(call.host) ?? 1) - 1);
    return answer("Z", call.lines);
  });
  await translate(t, 30, 1, [conn("a"), conn("b")], {
    split: {
      limits: new Map([
        ["a", 3],
        ["b", 1],
      ]),
    },
  });
  assert.deepEqual([peak.get("a.test"), peak.get("b.test")], [3, 1]);
});

test("an overflow slows only the connection that overflowed", async (t) => {
  let inFlight = 0;
  let onA = 0;
  let overflowed = false;
  let overflowedAt = 0;
  let settledPeak = 0;
  useFetch(t, async (call) => {
    if (call.host === "a.test") {
      onA += 1;
      if (onA === 2 && !overflowed) {
        overflowed = true;
        overflowedAt = Date.now();
        await new Promise((r) => setTimeout(r, 1));
        onA -= 1;
        return new Response('{"error":"context size has been exceeded"}', { status: 400 });
      }
    }
    inFlight += 1;
    // Requests already running when the overflow landed say nothing about the new limits.
    if (overflowed && Date.now() - overflowedAt > 40) settledPeak = Math.max(settledPeak, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight -= 1;
    if (call.host === "a.test") onA -= 1;
    return answer("Z", call.lines);
  });
  await translate(t, 60, 1, [conn("a"), conn("b")], {
    split: {
      limits: new Map([
        ["a", 2],
        ["b", 2],
      ]),
    },
  });
  assert.equal(overflowed, true);
  assert.equal(settledPeak, 3, "a at 1 plus b still at 2");
});

for (const [name, reason, expected] of [
  ["stop", "stop_requested", /STOP_REQUESTED/],
  ["cancel", new Error("JOB_CANCELLED"), /JOB_CANCELLED/],
] as const) {
  test(`a ${name} with a duplicate in flight ends both requests at once`, async (t) => {
    const controller = new AbortController();
    const stuck: Call[] = [];
    useFetch(t, (call) => {
      stuck.push(call);
      if (stuck.length === 2) setTimeout(() => controller.abort(reason), 1);
      return hang(call.signal);
    });
    const started = Date.now();
    await assert.rejects(translate(t, 1, 1, [conn("a"), conn("b")], { abortSignal: controller.signal }), expected);
    assert.ok(Date.now() - started < 2_000);
    assert.deepEqual(
      stuck.map((call) => call.signal?.aborted),
      [true, true],
    );
  });
}

test("a duplicate's win ends the original's per-line fallback", async (t) => {
  let lineCall: Call | undefined;
  let chunksOnA = 0;
  useFetch(t, (call) => {
    if (call.kind === "line") {
      if (call.host === "a.test" && !lineCall) {
        lineCall = call;
        return hang(call.signal);
      }
      return rejected();
    }
    if (call.host !== "a.test") return rejected();
    chunksOnA += 1;
    if (chunksOnA === 1) return rejected();
    return answer("DUP", call.lines);
  });
  const texts = await translate(t, 2, 2, [conn("a"), conn("b"), conn("c")], { split: threeHostSplit });
  assert.deepEqual(texts, ["DUP-cue 1", "DUP-cue 2"]);
  assert.equal(lineCall?.signal?.aborted, true);
});

test("a stuck availability probe does not hold a finished file open", async (t) => {
  const original = globalThis.fetch;
  useFetch(t, (call) => answer("B", call.lines));
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://a.test") && url.endsWith("/models")) return hang(init?.signal);
    return stubbed(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const started = Date.now();
  const texts = await translate(t, 2, 1, [conn("b"), conn("a")]);
  assert.deepEqual(texts, ["B-cue 1", "B-cue 2"]);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
});
