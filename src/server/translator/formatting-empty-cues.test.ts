import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { cuesOf, parseSubtitle } from "./convert.js";
import { loadCueProgress, saveCueProgress } from "./cue-progress.js";
import { partialOutputPath, translateFile, type TranslateFileOptions } from "./engine.js";
import { isBlankCueText } from "./subtitle-quality.js";
import { streamable } from "./streaming-chat-fixture.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

type Format = "srt" | "vtt" | "ass" | "ssa";
type Paths = { srtPath: string; outputPath: string };
type Payload = string | Array<string | { original: string; draft: string }>;

function files(t: TestContext, ext: Format, texts: string[]): Paths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-formatted-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srtPath = path.join(dir, `in.${ext}`);
  const content =
    ext === "ass" || ext === "ssa"
      ? "[Events]\nFormat: Layer, Start, End, Style, Text\n" +
        texts.map((text, i) => `Dialogue: 0,0:00:0${i}.00,0:00:0${i}.50,Default,${text}\n`).join("")
      : (ext === "vtt" ? "WEBVTT\n\n" : "") +
        texts
          .map((text, i) => {
            const separator = ext === "vtt" ? "." : ",";
            return `${i + 1}\n00:00:0${i}${separator}000 --> 00:00:0${i}${separator}500\n${text}\n`;
          })
          .join("\n");
  fs.writeFileSync(srtPath, content);
  return { srtPath, outputPath: path.join(dir, `out.${ext}`) };
}

function cues(filePath: string, ext: Format) {
  return cuesOf(parseSubtitle(fs.readFileSync(filePath, "utf8"), ext));
}

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "formatted-empty",
      object: "chat.completion",
      created: 0,
      model: "test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function useModel(t: TestContext, reply?: (payload: Payload) => string) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: string[] = [];
  const prompts: string[] = [];
  const payloads: Payload[] = [];
  globalThis.fetch = streamable((async (input: unknown, init?: RequestInit) => {
    requests.push(String(input));
    if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body));
    const prompt = String(body.messages.at(-1).content);
    prompts.push(prompt);
    if (String(body.messages[0].content).includes("subtitle content analyst")) return completion("A greeting.");
    const payload = JSON.parse(
      prompt.split("\n\n").find((part) => part.startsWith('"') || part.startsWith('["') || part.startsWith("[{")) ??
        "[]",
    ) as Payload;
    payloads.push(payload);
    return completion(
      reply?.(payload) ??
        (typeof payload === "string"
          ? `T ${payload}`
          : JSON.stringify(payload.map((line) => `T ${typeof line === "string" ? line : line.original}`))),
    );
  }) as typeof fetch);
  return { requests, prompts, payloads };
}

function run(paths: Paths, extra: Partial<TranslateFileOptions> = {}) {
  return translateFile({
    ...paths,
    connections: [{ id: "test", label: "Test", apiKey: "", apiHost: "http://formatted-empty.test/v1", model: "test" }],
    prompt: "Translate.",
    lang: "Chinese",
    additional: "",
    temperature: 0.3,
    chunkSize: 3,
    contextSize: 0,
    parallelChunks: 1,
    disableToolCalls: true,
    savedAnalysis: "A greeting.",
    ...extra,
  });
}

const blankSources: Record<Format, string[]> = {
  srt: ["<i> </i>", "<b>&nbsp;&lrm;&rlm;</b>"],
  vtt: ["<v Speaker><c.empty> </c></v>", "<00:00:00.000><lang en>&nbsp;&lrm;&rlm;</lang>"],
  ass: ["{\\an8}\\N\\h", "{\\i1}\\n{\\i0}"],
  ssa: ["{\\an8}\\N\\h", "{\\i1}\\n{\\i0}"],
};

test("blank classification follows the source format's entity rules", () => {
  for (const ext of ["ass", "ssa"] as const) {
    assert.equal(isBlankCueText("{\\i1}&nbsp;{\\i0}", ext), false);
    assert.equal(isBlankCueText("&lrm;&rlm;&#32;", ext), false);
  }
  for (const ext of ["srt", "vtt"] as const) {
    assert.equal(isBlankCueText("<i>&nbsp;&lrm;&rlm;</i>", ext), true);
    assert.equal(isBlankCueText("&NBSP;&LRM;&RLM;", ext), false);
    assert.equal(isBlankCueText("<i>&#32;&#160;&#xA0;&#x200E;</i>", ext), true);
    assert.equal(isBlankCueText("<i>&#65;</i>", ext), false);
    assert.equal(isBlankCueText("&#999999999;", ext), false);
  }
});

for (const ext of ["srt", "vtt", "ass", "ssa"] as const) {
  test(`formatting-only ${ext} files preserve raw cues and timing without model requests`, async (t) => {
    const paths = files(t, ext, blankSources[ext]);
    const model = useModel(t);
    await run(paths, { savedAnalysis: undefined, refinePass: true });
    assert.equal(model.requests.length, 0);
    assert.deepEqual(cues(paths.outputPath, ext), cues(paths.srtPath, ext));
  });

  for (const refinePass of [false, true]) {
    test(`mixed ${ext} cues preserve formatted blanks with refinement ${refinePass}`, async (t) => {
      const styled = ext === "ass" || ext === "ssa" ? "{\\i1}Hello{\\i0}" : "<i>Hello</i>";
      const sources = [styled, ...blankSources[ext], "World"];
      const paths = files(t, ext, sources);
      const partials: string[][] = [];
      const model = useModel(t, (payload) => {
        if (fs.existsSync(partialOutputPath(paths.outputPath))) {
          partials.push(cues(partialOutputPath(paths.outputPath), ext).map((cue) => cue.data?.text ?? ""));
        }
        assert.ok(Array.isArray(payload));
        return JSON.stringify(payload.map((line) => `T ${typeof line === "string" ? line : line.original}`));
      });
      await run(paths, { refinePass, contextSize: 1, savedAnalysis: undefined });
      const output = cues(paths.outputPath, ext);
      assert.deepEqual(
        output.map((cue) => cue.data?.text),
        [`T ${styled}`, ...blankSources[ext], "T World"],
      );
      assert.deepEqual(partials[0], [`T ${styled}`, ...blankSources[ext], "World"]);
      assert.deepEqual(
        output.map((cue) => [cue.data?.start, cue.data?.end]),
        cues(paths.srtPath, ext).map((cue) => [cue.data?.start, cue.data?.end]),
      );
      assert.deepEqual(
        model.payloads.flatMap((payload) =>
          Array.isArray(payload) ? payload.map((line) => (typeof line === "string" ? line : line.original)) : [payload],
        ),
        refinePass ? [styled, styled, "World", "World"] : [styled, "World"],
      );
      for (const blank of blankSources[ext]) {
        assert.ok(
          model.prompts.every((prompt) => !prompt.includes(blank)),
          "blank formatting stays out of model context",
        );
      }
    });
  }

  test(`resumed ${ext} cues discard invented blank translations and preserve raw formatting`, async (t) => {
    const paths = files(t, ext, [...blankSources[ext], "Hello"]);
    saveCueProgress(
      paths.outputPath,
      "same-work",
      new Map([
        [0, "Invented"],
        [1, "Invented"],
        [2, "T Hello"],
      ]),
    );
    const model = useModel(t);
    await run(paths, { resumeKey: "same-work", refinePass: true });
    assert.equal(model.requests.length, 0);
    assert.deepEqual(
      cues(paths.outputPath, ext).map((cue) => cue.data?.text),
      [...blankSources[ext], "T Hello"],
    );
  });
}

for (const recovery of ["line fallback", "leftover sweep"]) {
  test(`${recovery} sends only visible sources after incomplete chunk output`, async (t) => {
    const styled = "<i>Hello</i>";
    const paths = files(t, "srt", [styled, ...blankSources.srt]);
    const model = useModel(t, (payload) =>
      Array.isArray(payload)
        ? JSON.stringify(recovery === "line fallback" ? [] : payload.map(() => ""))
        : `T ${payload}`,
    );
    await run(paths);
    assert.deepEqual(
      model.payloads.filter((payload) => typeof payload === "string"),
      [styled],
    );
    assert.deepEqual(
      cues(paths.outputPath, "srt").map((cue) => cue.data?.text),
      [`T ${styled}`, ...blankSources.srt],
    );
  });
}

test("unfinished jobs cache raw formatting for completed blank chunks", async (t) => {
  const paths = files(t, "srt", [...blankSources.srt, "Hello"]);
  useModel(t, () => {
    throw new Error("STOP_REQUESTED");
  });
  await assert.rejects(run(paths, { chunkSize: 2, resumeKey: "same-work", refinePass: true }), /STOP_REQUESTED/);
  assert.deepEqual(
    [...loadCueProgress(paths.outputPath, "same-work").cues],
    blankSources.srt.map((text, i) => [i, text]),
  );
  assert.deepEqual(
    cues(partialOutputPath(paths.outputPath), "srt").map((cue) => cue.data?.text),
    [...blankSources.srt, "Hello"],
  );
});
