import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveCueProgress } from "./cue-progress.js";
import { partialOutputPath, translateFile } from "./engine.js";
import { extractJsonFromText, parseSubtitle, type SubtitleCue } from "./utils.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "empty-cues",
      object: "chat.completion",
      created: 0,
      model: "test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function cueTexts(filePath: string): string[] {
  const parsed = parseSubtitle(fs.readFileSync(filePath, "utf8"), "srt") as SubtitleCue[];
  return parsed.filter((cue) => cue.type === "cue").map((cue) => (cue.data?.text ?? "").trim());
}

for (const refinePass of [false, true]) {
  test(`empty cues stay blank in final and partial output with refinement ${refinePass}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-empty-cues-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const srtPath = path.join(dir, "in.srt");
    const outputPath = path.join(dir, "out.srt");
    fs.writeFileSync(
      srtPath,
      ["Hello", "", " \t ", "World"]
        .map((text, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},500\n${text}\n`)
        .join("\n"),
    );
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const partials: string[][] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
      const body = JSON.parse(String(init?.body));
      const prompt = String(body.messages.at(-1).content);
      if (fs.existsSync(partialOutputPath(outputPath))) partials.push(cueTexts(partialOutputPath(outputPath)));
      const payload = extractJsonFromText(prompt) as Array<string | { original: string; draft: string }>;
      return completion(
        JSON.stringify(
          payload.map((line) => {
            const source = typeof line === "string" ? line : line.original;
            return source.trim() ? `T ${source}` : "Invented speech";
          }),
        ),
      );
    }) as typeof fetch;

    await translateFile({
      srtPath,
      outputPath,
      connections: [{ id: "test", label: "Test", apiKey: "", apiHost: "http://empty.test/v1", model: "test" }],
      prompt: "Translate.",
      lang: "Chinese",
      additional: "",
      temperature: 0.3,
      chunkSize: 3,
      contextSize: 0,
      parallelChunks: 1,
      disableToolCalls: true,
      savedAnalysis: "A greeting.",
      refinePass,
    });

    assert.deepEqual(cueTexts(outputPath), ["T Hello", "", "", "T World"]);
    assert.deepEqual(partials[0], ["T Hello", "", "", "World"]);
    const outputCues = parseSubtitle(fs.readFileSync(outputPath, "utf8"), "srt") as SubtitleCue[];
    assert.deepEqual(
      outputCues.map((cue) => [cue.data?.start, cue.data?.end]),
      [
        [0, 500],
        [1000, 1500],
        [2000, 2500],
        [3000, 3500],
      ],
    );
  });
}

test("resuming discards invented translations saved for blank source cues", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-empty-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srtPath = path.join(dir, "in.srt");
  const outputPath = path.join(dir, "out.srt");
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:02,000 --> 00:00:03,000\nHello\n");
  saveCueProgress(
    outputPath,
    "same-work",
    new Map([
      [0, "Invented speech"],
      [1, "T Hello"],
    ]),
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => {
    throw new Error("Resumed cues need no model call");
  }) as typeof fetch;

  await translateFile({
    srtPath,
    outputPath,
    connections: [{ id: "test", label: "Test", apiKey: "", apiHost: "http://empty.test/v1", model: "test" }],
    prompt: "Translate.",
    lang: "Chinese",
    additional: "",
    temperature: 0.3,
    chunkSize: 2,
    contextSize: 0,
    parallelChunks: 1,
    disableToolCalls: true,
    savedAnalysis: "A greeting.",
    resumeKey: "same-work",
  });

  assert.deepEqual(cueTexts(outputPath), ["", "T Hello"]);
});

test("an entirely blank subtitle completes without contacting a model", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-all-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srtPath = path.join(dir, "in.srt");
  const outputPath = path.join(dir, "out.srt");
  fs.writeFileSync(srtPath, "1\n00:00:01,000 --> 00:00:02,000\n\n");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return completion('["Invented speech"]');
  }) as typeof fetch;
  const progress: number[] = [];

  await translateFile({
    srtPath,
    outputPath,
    connections: [{ id: "test", label: "Test", apiKey: "", apiHost: "http://empty.test/v1", model: "test" }],
    prompt: "Translate.",
    lang: "Chinese",
    additional: "",
    temperature: 0.3,
    chunkSize: 2,
    contextSize: 0,
    parallelChunks: 1,
    disableToolCalls: true,
    onProgress: (completed) => progress.push(completed),
  });

  assert.deepEqual(cueTexts(outputPath), [""]);
  assert.equal(requests, 0);
  assert.deepEqual(progress, [0, 1]);
});
