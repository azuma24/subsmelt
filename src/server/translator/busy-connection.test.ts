import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translateFile } from "./engine.js";
import type { ResolvedConnection } from "../connections.js";

(globalThis as any).AI_SDK_LOG_WARNINGS = false;

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

test("chunks avoid a busy machine and return to it once it is free", async (t) => {
  const busyHost = "http://10.0.0.1:1234/v1";
  const spareHost = "http://10.0.0.2:1234/v1";
  const servedBy: string[] = [];
  const analysedBy: string[] = [];
  let busy = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body));
    const system = body.messages.find((m: any) => m.role === "system")?.content ?? "";
    if (String(system).includes("subtitle content analyst")) {
      analysedBy.push(url.startsWith(busyHost) ? "primary" : "spare");
      return chatCompletion("Summary.");
    }
    const user = String(body.messages.find((m: any) => m.role === "user")?.content ?? "");
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    servedBy.push(url.startsWith(busyHost) ? "primary" : "spare");
    // The transcription finishes after the second chunk.
    if (servedBy.length === 2) busy = false;
    return chatCompletion(JSON.stringify(lines.map((line) => `T ${line}`)));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-busy-"));
  const srtPath = path.join(dir, "Episode 01.srt");
  const outputPath = path.join(dir, "Episode 01.chi.srt");
  const srt = Array.from({ length: 20 }, (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:01,500\ncue ${i + 1}\n`).join(
    "\n",
  );
  fs.writeFileSync(srtPath, srt, "utf8");

  const primary: ResolvedConnection = { id: "pc", label: "PC", apiKey: "", apiHost: busyHost, model: "m" };
  const spare: ResolvedConnection = { id: "mac", label: "Mac", apiKey: "", apiHost: spareHost, model: "m" };

  await translateFile({
    srtPath,
    outputPath,
    prompt: "Translate.",
    lang: "Chinese",
    additional: "",
    temperature: 0.3,
    contextSize: 0,
    requestTimeoutMs: 5_000,
    disableToolCalls: true,
    chunkSize: 5,
    parallelChunks: 1,
    connections: [primary, spare],
    llmMode: "fallback",
    isConnectionBusy: (conn) => busy && conn.id === "pc",
  });

  assert.deepEqual(analysedBy, ["spare"], "the file's first request avoids the busy machine too");
  assert.deepEqual(servedBy, ["spare", "spare", "primary", "primary"]);
});
