import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedConnection } from "../connections.js";
import { cueProgressPath, loadCueProgress, saveCueProgress } from "./cue-progress.js";
import { translateFile } from "./engine.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const connection: ResolvedConnection = { id: "a", label: "A", apiKey: "", apiHost: "http://a.test/v1", model: "m" };

function completion(content: string): Response {
  const body = {
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Translates by tagging each line with `tag`, recording what was sent. Throws on a line in `failOn`. */
function useLlm(t: { after(fn: () => void): void }, tag: string, failOn?: string) {
  const sent: string[][] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init.body));
    if (String(body.messages[0].content).includes("subtitle content analyst")) return completion("Summary.");
    const user = String(body.messages.at(-1).content);
    const lines = JSON.parse(user.slice(user.lastIndexOf("["))) as string[];
    if (failOn && lines.includes(failOn)) throw new Error("STOP_REQUESTED");
    sent.push(lines);
    return completion(JSON.stringify(lines.map((l) => `${tag}-${l}`)));
  }) as unknown as typeof fetch;
  return sent;
}

function files(t: { after(fn: () => void): void }, cues: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srtPath = path.join(dir, "in.srt");
  fs.writeFileSync(
    srtPath,
    Array.from({ length: cues }, (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:01,500\ncue ${i + 1}\n`).join("\n"),
    "utf8",
  );
  return { srtPath, outputPath: path.join(dir, "out.srt") };
}

const run = (
  paths: { srtPath: string; outputPath: string },
  extra: Partial<Parameters<typeof translateFile>[0]> = {},
) =>
  translateFile({
    ...paths,
    prompt: "",
    lang: "Chinese",
    additional: "",
    temperature: 0.3,
    chunkSize: 2,
    contextSize: 0,
    parallelChunks: 1,
    disableToolCalls: true,
    connections: [connection],
    resumeKey: "key",
    ...extra,
  });

const output = (outputPath: string) =>
  fs
    .readFileSync(outputPath, "utf8")
    .trim()
    .split(/\n\n+/)
    .map((cue) => cue.split("\n").slice(2).join("\n").trim());

test("a stopped file continues with only the chunks it had not finished", async (t) => {
  const paths = files(t, 6);
  useLlm(t, "OLD", "cue 3");
  await assert.rejects(run(paths), /STOP_REQUESTED/);
  assert.deepEqual(
    [...loadCueProgress(paths.outputPath, "key")],
    [
      [0, "OLD-cue 1"],
      [1, "OLD-cue 2"],
    ],
  );

  const sent = useLlm(t, "NEW");
  const ticks: number[] = [];
  await run(paths, { onProgress: (completed) => ticks.push(completed) });

  assert.deepEqual(sent, [
    ["cue 3", "cue 4"],
    ["cue 5", "cue 6"],
  ]);
  assert.deepEqual(output(paths.outputPath), [
    "OLD-cue 1",
    "OLD-cue 2",
    "NEW-cue 3",
    "NEW-cue 4",
    "NEW-cue 5",
    "NEW-cue 6",
  ]);
  assert.deepEqual(ticks, [0, 2, 4, 6]);
  assert.equal(fs.existsSync(cueProgressPath(paths.outputPath)), false, "the sidecar goes away with the job");
});

test("a chunk with any cue missing runs again in full", async (t) => {
  const paths = files(t, 4);
  saveCueProgress(
    paths.outputPath,
    "key",
    new Map([
      [0, "OLD-cue 1"],
      [1, "OLD-cue 2"],
      [2, "OLD-cue 3"],
    ]),
  );
  const sent = useLlm(t, "NEW");
  await run(paths);
  assert.deepEqual(sent, [["cue 3", "cue 4"]]);
  assert.deepEqual(output(paths.outputPath), ["OLD-cue 1", "OLD-cue 2", "NEW-cue 3", "NEW-cue 4"]);
});

test("a file with every chunk saved sends no chunks", async (t) => {
  const paths = files(t, 2);
  saveCueProgress(
    paths.outputPath,
    "key",
    new Map([
      [0, "OLD-cue 1"],
      [1, "OLD-cue 2"],
    ]),
  );
  const sent = useLlm(t, "NEW");
  await run(paths);
  assert.deepEqual(sent, []);
  assert.deepEqual(output(paths.outputPath), ["OLD-cue 1", "OLD-cue 2"]);
});

test("progress saved for different work is thrown away", async (t) => {
  const paths = files(t, 2);
  saveCueProgress(
    paths.outputPath,
    "other",
    new Map([
      [0, "OLD-cue 1"],
      [1, "OLD-cue 2"],
    ]),
  );
  useLlm(t, "NEW");
  await run(paths);
  assert.deepEqual(output(paths.outputPath), ["NEW-cue 1", "NEW-cue 2"]);
});

test("a damaged progress file means starting over", async (t) => {
  const paths = files(t, 2);
  fs.writeFileSync(cueProgressPath(paths.outputPath), '{"workKey":"key","cues":', "utf8");
  useLlm(t, "NEW");
  await run(paths);
  assert.deepEqual(output(paths.outputPath), ["NEW-cue 1", "NEW-cue 2"]);
});

test("without a resume key nothing is saved or read", async (t) => {
  const paths = files(t, 2);
  saveCueProgress(
    paths.outputPath,
    "key",
    new Map([
      [0, "OLD-cue 1"],
      [1, "OLD-cue 2"],
    ]),
  );
  useLlm(t, "NEW", "cue 2");
  await assert.rejects(
    run({ ...paths, srtPath: paths.srtPath }, { resumeKey: undefined, chunkSize: 1 }),
    /STOP_REQUESTED/,
  );
  const before = fs.readFileSync(cueProgressPath(paths.outputPath), "utf8");
  assert.equal(before.includes("NEW"), false);
});

test("a resumed split file sends only the rest across connections", async (t) => {
  const paths = files(t, 4);
  saveCueProgress(
    paths.outputPath,
    "key",
    new Map([
      [0, "OLD-cue 1"],
      [1, "OLD-cue 2"],
    ]),
  );
  const sent = useLlm(t, "NEW");
  const b: ResolvedConnection = { ...connection, id: "b", label: "B", apiHost: "http://b.test/v1" };
  await run(paths, {
    connections: [connection, b],
    llmMode: "parallel",
    split: {
      limits: new Map([
        ["a", 1],
        ["b", 1],
      ]),
    },
  });
  assert.deepEqual(sent, [["cue 3", "cue 4"]]);
  assert.deepEqual(output(paths.outputPath), ["OLD-cue 1", "OLD-cue 2", "NEW-cue 3", "NEW-cue 4"]);
});

test("Preview shows the kept cues as soon as a run resumes", async (t) => {
  const paths = files(t, 4);
  saveCueProgress(
    paths.outputPath,
    "key",
    new Map([
      [0, "OLD-cue 1"],
      [1, "OLD-cue 2"],
    ]),
  );
  useLlm(t, "NEW", "cue 3");
  await assert.rejects(run(paths), /STOP_REQUESTED/);
  assert.match(fs.readFileSync(`${paths.outputPath}.part`, "utf8"), /OLD-cue 2/);
});
