import assert from "node:assert/strict";

import fs from "node:fs";

import os from "node:os";

import path from "node:path";

// queue.ts pulls in db.ts, config.ts and scanner.ts, which bind their
// directories at import, so point all three at scratch folders first.
export const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-queue-split-"));

process.env.DATA_DIR = path.join(scratch, "data");

process.env.CONFIG_DIR = path.join(scratch, "config");

process.env.MEDIA_DIR = path.join(scratch, "media");

fs.mkdirSync(process.env.MEDIA_DIR);

export const db = await import("./db.js");

export const config = await import("./config.js");

export const queue = await import("./queue.js");

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

export function chatCompletion(content: string): Response {
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

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const taskId = config.createTask({
  source_lang: "Automatic",
  target_lang: "Chinese",
  output_pattern: "{name}.chi.srt",
  lang_code: "chi",
}).lastInsertRowid;

export const mediaDir = process.env.MEDIA_DIR;

export let jobSeq = 0;

export function addJob(opts: { srtExists: boolean; outputExists: boolean }) {
  jobSeq += 1;
  const srtPath = path.join(mediaDir, `job-${jobSeq}.srt`);
  const outputPath = path.join(mediaDir, `job-${jobSeq}.chi.srt`);
  const cue = "1\n00:00:01,000 --> 00:00:02,000\nhello\n";
  if (opts.srtExists) fs.writeFileSync(srtPath, cue, "utf8");
  if (opts.outputExists) fs.writeFileSync(outputPath, cue, "utf8");
  const result = db.createJob({ task_id: taskId, srt_path: srtPath, output_path: outputPath, video_path: null });
  return Number(result.lastInsertRowid);
}

export function useConnections(mode: string, connections: object[]) {
  config.setSetting("llm_mode", mode);
  config.setSetting("llm_connections", JSON.stringify(connections));
}

// ── Split one file across connections (llm_split_file) ───────────────────────
// These tests need per-host routing, peak-concurrency control and per-cue
// translations, so each installs its own fetch stub and restores the default
// afterwards.

// Each test installs its own stub; anything outside one must not reach the network.
export const moduleFetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

globalThis.fetch = moduleFetch;

export interface SplitInfo {
  host: string;
  kind: "analysis" | "chunk";
  lines: string[];
}

export function splitRequestInfo(input: string | URL | Request, init?: RequestInit): SplitInfo {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const body = JSON.parse(String(init?.body ?? "{}"));
  const system = String(body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "");
  const user = String(body.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "");
  if (system.includes("subtitle content analyst")) return { host: url.host, kind: "analysis", lines: [] };
  const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
  return { host: url.host, kind: "chunk", lines };
}

export function useSplitFetch(
  t: { after(fn: () => void): void },
  chat: (info: SplitInfo, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response('{"data":[]}', { status: 200 });
    if (!url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
    return chat(splitRequestInfo(input, init), init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = moduleFetch;
  });
}

export function splitSrt(cues: number): string {
  return Array.from({ length: cues }, (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:01,500\ncue ${i + 1}\n`).join("\n");
}

export function srtCueTexts(srt: string): string[] {
  return srt
    .trim()
    .split(/\n\n+/)
    .map((block) => block.split("\n").slice(2).join("\n").trim());
}

/** The output must read `Z-<source>` for every cue, in the source file's order. */
export function assertCuesTranslatedInOrder(srt: string, cues: number) {
  assert.deepEqual(
    srtCueTexts(srt),
    Array.from({ length: cues }, (_, i) => `Z-cue ${i + 1}`),
  );
}

export function useParallelConnections(firstEndpoint: string, secondEndpoint: string) {
  useConnections("parallel", [
    { id: "a", label: "Host A", provider: "local", model: "m", endpoint: firstEndpoint, order: 0 },
    { id: "b", label: "Host B", provider: "local", model: "m", endpoint: secondEndpoint, order: 1 },
  ]);
  config.setSetting("disable_tool_calls", "1");
}

// ── Hedging a stalled chunk to another machine (llm_split_file) ─────────────

export interface StuckCall {
  host: string;
  aborted: boolean;
  answer: (content: string) => void;
}

export function hostTag(host: string): string {
  return host === "a.test" ? "A" : "B";
}

export function useStalledChunkFetch(
  t: { after(fn: () => void): void },
  stuckLine: string,
  duplicate: (call: StuckCall) => Response | Promise<Response>,
) {
  const original = { call: null as StuckCall | null };
  const duplicates: StuckCall[] = [];
  useSplitFetch(t, (info, init) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    if (!info.lines.includes(stuckLine)) {
      return chatCompletion(JSON.stringify(info.lines.map((l) => `${hostTag(info.host)}-${l}`)));
    }
    const call: StuckCall = { host: info.host, aborted: false, answer: () => {} };
    return new Promise<Response>((resolve, reject) => {
      call.answer = (content) => resolve(chatCompletion(content));
      init?.signal?.addEventListener(
        "abort",
        () => {
          call.aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
      if (original.call) {
        duplicates.push(call);
        Promise.resolve()
          .then(() => duplicate(call))
          .then(resolve, reject);
        return;
      }
      original.call = call;
    });
  });
  return { original, duplicates };
}

export const hedgeSettings = () => {
  useParallelConnections("http://a.test/v1", "http://b.test/v1");
  config.setSetting("llm_split_file", "1");
  config.setSetting("chunk_size", "1");
  config.setSetting("parallel_chunks", "1");
};

export const clearHedgeSettings = () => {
  config.setSetting("llm_split_file", "0");
  config.setSetting("chunk_size", "");
  config.setSetting("parallel_chunks", "");
};

/** Sorts chat requests into chunks (translated by echo) and anything else, such as a title. */
export function useRawChat(
  t: { after(fn: () => void): void },
  first: (host: string, system: string) => Response | null,
  titleHosts: string[],
) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/models")) return new Response('{"data":[]}', { status: 200 });
    if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const system = String(body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "");
    const user = String(body.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "");
    const isTitle = !user.includes("cue ");
    if (isTitle) titleHosts.push(url.hostname);
    const answer = first(url.hostname, system);
    if (answer) return answer;
    if (isTitle) return chatCompletion("Translated Title");
    await new Promise((r) => setTimeout(r, 200));
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    return chatCompletion(JSON.stringify(lines.map((l) => `Z-${l}`)));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = moduleFetch;
  });
}

export function useHoldingFetch(t: { after(fn: () => void): void }) {
  const held: { host: string; answer: () => void }[] = [];
  useSplitFetch(t, (info, init) => {
    if (info.kind === "analysis") return chatCompletion("Summary.");
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
      held.push({
        host: info.host,
        answer: () => resolve(chatCompletion(JSON.stringify(info.lines.map((l) => `Z-${l}`)))),
      });
    });
  });
  return held;
}

export const answerAllUntil = async (held: { answer: () => void }[], done: () => boolean) => {
  while (!done()) {
    for (const call of held.splice(0)) call.answer();
    await new Promise((r) => setTimeout(r, 5));
  }
};
