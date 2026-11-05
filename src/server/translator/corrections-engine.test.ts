import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translateFile } from "./engine.js";
import {
  compileCorrectionsFor,
  correctionGlossaryTerms,
  type CorrectionCounts,
  type CorrectionRule,
  type CorrectionRuleSet,
} from "../../shared/corrections.js";

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

function messageContent(body: any, role: string): string {
  const message = body.messages.find((m: any) => m.role === role);
  return typeof message?.content === "string" ? message.content : "";
}

function rule(find: string, replace: string, extra: Partial<CorrectionRule> = {}): CorrectionRule {
  return {
    id: find,
    find,
    replace,
    stage: "source",
    match: "word",
    caseSensitive: true,
    languages: [],
    enabled: true,
    ...extra,
  };
}

test("source rules fix what the LLM reads and pin the term; output rules fix what is saved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-corrections-engine-"));
  const srtPath = path.join(dir, "Talk.en.srt");
  const outputPath = path.join(dir, "Talk.chi.srt");
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\nSerenity makes Anchor gear\n", "utf8");

  const set: CorrectionRuleSet = {
    id: "sereniti",
    name: "Sereniti",
    enabled: true,
    paths: [""],
    rules: [
      rule("Serenity", "Sereniti"),
      rule("Anchor", "AnKor"),
      rule("賽瑞尼", "Sereniti", { stage: "output", match: "phrase" }),
    ],
  };
  const source = compileCorrectionsFor([set], "Talk.en.srt", "source");
  const output = compileCorrectionsFor([set], "Talk.en.srt", "output", ["chi"]);

  const chunkPrompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body));
    if (messageContent(body, "system").includes("subtitle content analyst")) return chatCompletion("Summary: a talk.");
    const user = messageContent(body, "user");
    chunkPrompts.push(user);
    // The "model" gets the brand wrong in Chinese; the output rule fixes it.
    return chatCompletion(JSON.stringify(["賽瑞尼 製造 AnKor 設備"]));
  }) as typeof fetch;

  const reported: Array<[string, CorrectionCounts]> = [];
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
      chunkSize: 5,
      contextSize: 0,
      parallelChunks: 1,
      requestTimeoutMs: 5_000,
      disableToolCalls: true,
      sourceCorrections: source,
      outputCorrections: output,
      pinnedTerms: correctionGlossaryTerms(source),
      onCorrections: (stage, counts) => reported.push([stage, counts]),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const prompt = chunkPrompts.join("\n");
  assert.match(prompt, /Sereniti makes AnKor gear/);
  assert.doesNotMatch(prompt, /Serenity|Anchor/);
  assert.match(prompt, /- Sereniti -> Sereniti/);
  assert.match(prompt, /- AnKor -> AnKor/);
  assert.match(fs.readFileSync(outputPath, "utf8"), /Sereniti 製造 AnKor 設備/);
  assert.deepEqual(reported, [
    ["source", { Serenity: 1, Anchor: 1 }],
    ["output", { 賽瑞尼: 1 }],
  ]);
});

test("checked rules ask the LLM per match and replace only a confirmed one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-corrections-check-"));
  const srtPath = path.join(dir, "Talk.en.srt");
  const outputPath = path.join(dir, "Talk.chi.srt");
  fs.writeFileSync(
    srtPath,
    "1\n00:00:01,000 --> 00:00:02,000\nOpen the anchor app\n\n2\n00:00:03,000 --> 00:00:04,000\nWe anchor the dashboards\n",
    "utf8",
  );
  const set: CorrectionRuleSet = {
    id: "sereniti",
    name: "Sereniti",
    enabled: true,
    paths: [""],
    rules: [rule("anchor", "AnKor", { confirm: true })],
  };
  const source = compileCorrectionsFor([set], "Talk.en.srt", "source");
  const chunkPrompts: string[] = [];
  let checks = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body));
    const system = messageContent(body, "system");
    if (system.includes("subtitle content analyst")) return chatCompletion("Summary: a talk.");
    const user = messageContent(body, "user");
    if (system.includes("You check subtitle corrections")) {
      checks++;
      const items = JSON.parse(user.slice(user.indexOf("[\n"))) as Array<{ id: number; line: string }>;
      return chatCompletion(JSON.stringify(items.map((i) => ({ id: i.id, replace: /» app/.test(i.line) }))));
    }
    chunkPrompts.push(user);
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    return chatCompletion(JSON.stringify(lines.map((l) => `T ${l}`)));
  }) as typeof fetch;

  const checked: Array<[string, Record<string, number>, Record<string, number>]> = [];
  const usageKinds: string[] = [];
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
      chunkSize: 5,
      contextSize: 0,
      parallelChunks: 1,
      requestTimeoutMs: 5_000,
      disableToolCalls: true,
      sourceCorrections: source,
      pinnedTerms: correctionGlossaryTerms(source),
      onCorrectionChecks: (stage, result) => checked.push([stage, result.confirmed, result.kept]),
      onUsage: (u) => usageKinds.push(u.kind),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(checks, 1);
  assert.deepEqual(checked, [["source", { anchor: 1 }, { anchor: 1 }]]);
  const prompt = chunkPrompts.join("\n");
  assert.match(prompt, /Open the AnKor app/);
  assert.match(prompt, /We anchor the dashboards/);
  // A checked rule's term is never pinned as a name.
  assert.doesNotMatch(prompt, /AnKor -> AnKor/);
  assert.ok(usageKinds.includes("check"));
});

test("an offline first connection hands the check to the next one instead of failing the job", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-corrections-fallback-"));
  const srtPath = path.join(dir, "Talk.en.srt");
  const outputPath = path.join(dir, "Talk.chi.srt");
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\nOpen the anchor app\n", "utf8");
  const set: CorrectionRuleSet = {
    id: "sereniti",
    name: "Sereniti",
    enabled: true,
    paths: [""],
    rules: [rule("anchor", "AnKor", { confirm: true })],
  };
  const source = compileCorrectionsFor([set], "Talk.en.srt", "source");
  const checkedBy: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1:9/")) throw new TypeError("fetch failed: connect ECONNREFUSED");
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body));
    const system = messageContent(body, "system");
    if (system.includes("subtitle content analyst")) return chatCompletion("Summary: a talk.");
    const user = messageContent(body, "user");
    if (system.includes("You check subtitle corrections")) {
      checkedBy.push(url);
      const items = JSON.parse(user.slice(user.indexOf("[\n"))) as Array<{ id: number }>;
      return chatCompletion(JSON.stringify(items.map((i) => ({ id: i.id, replace: true }))));
    }
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    return chatCompletion(JSON.stringify(lines.map((l) => `T ${l}`)));
  }) as typeof fetch;
  try {
    await translateFile({
      srtPath,
      outputPath,
      connections: [
        { id: "down", label: "down", apiKey: "", apiHost: "http://127.0.0.1:9/v1", model: "test-model" },
        { id: "up", label: "up", apiKey: "", apiHost: "http://127.0.0.2:9/v1", model: "test-model" },
      ],
      llmMode: "fallback",
      prompt: "Translate.",
      lang: "Chinese",
      additional: "",
      temperature: 0.3,
      chunkSize: 5,
      contextSize: 0,
      parallelChunks: 1,
      requestTimeoutMs: 5_000,
      disableToolCalls: true,
      sourceCorrections: source,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(checkedBy.length > 0 && checkedBy.every((url) => url.startsWith("http://127.0.0.2:9/")));
  assert.match(fs.readFileSync(outputPath, "utf8"), /T Open the AnKor app/);
});
