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
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\nUbiquity makes Unify gear\n", "utf8");

  const set: CorrectionRuleSet = {
    id: "ubnt",
    name: "Ubiquiti",
    enabled: true,
    paths: [""],
    rules: [
      rule("Ubiquity", "Ubiquiti"),
      rule("Unify", "UniFi"),
      rule("優比快", "Ubiquiti", { stage: "output", match: "phrase" }),
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
    return chatCompletion(JSON.stringify(["優比快 製造 UniFi 設備"]));
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
  assert.match(prompt, /Ubiquiti makes UniFi gear/);
  assert.doesNotMatch(prompt, /Ubiquity|Unify/);
  assert.match(prompt, /- Ubiquiti -> Ubiquiti/);
  assert.match(prompt, /- UniFi -> UniFi/);
  assert.match(fs.readFileSync(outputPath, "utf8"), /Ubiquiti 製造 UniFi 設備/);
  assert.deepEqual(reported, [
    ["source", { Ubiquity: 1, Unify: 1 }],
    ["output", { 優比快: 1 }],
  ]);
});
