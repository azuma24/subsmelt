import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";

// config.ts, scanner.ts and transcription/work.ts read these at import, so point them at a scratch folder first.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-retry-")));
const mediaDir = path.join(root, "media");
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = mediaDir;
fs.mkdirSync(path.join(mediaDir, "show"), { recursive: true });

const videoPath = path.join(mediaDir, "show", "Episode 01.mkv");
fs.writeFileSync(videoPath, "video", "utf8");
const secondVideoPath = path.join(mediaDir, "show", "Episode 02.mkv");
fs.writeFileSync(secondVideoPath, "video", "utf8");

const { default: express } = await import("express");
const { setSettings, createTask, updateTask } = await import("../config.js");
const { registerTranscriptionRoutes } = await import("./transcription.js");
const { transcriptionWork, WorkStore } = await import("../transcription/work.js");

const app = express();
app.use(express.json());
registerTranscriptionRoutes(app);
const appServer = app.listen(0, "127.0.0.1");
await once(appServer, "listening");
const appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
after(() => {
  appServer.closeAllConnections();
  appServer.close();
});

// A backend that records each transcribe request body and answers with a finished subtitle.
async function startBackend(subtitlePath: string, content = "1") {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, safe: true }));
      return;
    }
    if (req.url !== "/transcribe/stream" && req.url !== "/transcribe/url/stream") {
      res.writeHead(404).end();
      return;
    }
    bodies.push(JSON.parse(raw));
    if (req.url === "/transcribe/stream" && subtitlePath.startsWith(mediaDir)) {
      fs.writeFileSync(subtitlePath, content);
    }
    const result = { type: "result", ok: true, subtitle_path: subtitlePath, content, language: "en", segments: 3 };
    res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(`${JSON.stringify(result)}\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// The Transcribe page retries a history attempt by queueing this request.
async function queueRetry(input: string, request: Record<string, unknown>, kind = "file"): Promise<string> {
  const res = await fetch(`${appUrl}/api/transcribe/work`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: [{ kind, input, request }] }),
  });
  assert.equal(res.status, 202);
  const id = ((await res.json()) as { items: Array<{ id: string }> }).items[0].id;
  await transcriptionWork.idle();
  return id;
}

test("a retry reuses the attempt's model and language, not the current defaults", async () => {
  const backend = await startBackend("/srv/show/Episode 01.ja.srt");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
    transcription_model: "small",
    transcription_language: "en",
  });
  try {
    await queueRetry(videoPath, {
      postAction: "transcribe_only",
      outputFormat: "srt",
      model: "nemotron-3.5-asr",
      language: "ja",
    });
    assert.deepEqual(
      backend.bodies.map(({ model, language }) => ({ model, language })),
      [{ model: "nemotron-3.5-asr", language: "ja" }],
    );
  } finally {
    backend.close();
  }
});

test("a retry replays the attempt's device, compute type, format and advanced options", async () => {
  const backend = await startBackend("/srv/show/Episode 02.vtt");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
    transcription_device: "cpu",
    transcription_compute_type: "int8",
    transcription_advanced_stt: JSON.stringify({ beam_size: 1 }),
  });
  try {
    await queueRetry(secondVideoPath, {
      postAction: "transcribe_only",
      outputFormat: "vtt",
      model: "large-v3",
      language: "auto",
      device: "cuda",
      computeType: "float16",
      advancedOptions: { beam_size: 8, speaker_diarization: true },
    });
    assert.deepEqual(
      backend.bodies.map(({ model, device, compute_type, output_format, advanced_options }) => ({
        model,
        device,
        compute_type,
        output_format,
        advanced_options,
      })),
      [
        {
          model: "large-v3",
          device: "cuda",
          compute_type: "float16",
          output_format: "vtt",
          advanced_options: { beam_size: 8, speaker_diarization: true },
        },
      ],
    );
  } finally {
    backend.close();
  }
});

test("a URL run takes the same Settings as a library file", async () => {
  const backend = await startBackend("/unused");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_model: "large-v3",
    transcription_language: "ja",
    transcription_advanced_stt: JSON.stringify({ beam_size: 6 }),
    transcription_low_ram_behavior: "run_anyway",
  });
  try {
    await queueRetry("https://example.org/talk", { speakerDiarization: true }, "url");
    assert.deepEqual(
      backend.bodies.map(({ url, model, language, use_vad, post_action, allow_unsafe, advanced_options }) => ({
        url,
        model,
        language,
        use_vad,
        post_action,
        allow_unsafe,
        advanced_options,
      })),
      [
        {
          url: "https://example.org/talk",
          model: "large-v3",
          language: "ja",
          use_vad: true,
          post_action: "transcribe_only",
          allow_unsafe: true,
          advanced_options: { beam_size: 6, speaker_diarization: true },
        },
      ],
    );
  } finally {
    setSettings({ transcription_advanced_stt: "", transcription_low_ram_behavior: "" });
    backend.close();
  }
});

test("a resolved profile keeps its source in review, then publishes only selected translation work and a note", async () => {
  const { getJobBySrtAndTask } = await import("../db.js");
  const { scanFolder } = await import("../scanner.js");
  const { queueFileTranslation } = await import("../file-translation.js");
  const { setYoutubeBacklogSource } = await import("../gpu-gate.js");
  const { requestStop } = await import("../queue.js");
  setYoutubeBacklogSource(() => 1);
  const video = path.join(mediaDir, "show", "Review.mkv");
  const initial = path.join(mediaDir, "show", "Review.en.srt");
  const content = "1\n00:00:01,000 --> 00:00:03,000\nInitial dialogue.\n";
  fs.writeFileSync(video, "video");
  const backend = await startBackend(initial, content);
  const task = (target_lang: string, lang_code: string) =>
    createTask({
      target_lang,
      lang_code,
      source_lang: "English",
      output_pattern: "{{name}}.{{lang_code}}.srt",
    }).lastInsertRowid;
  const spanish = task("Spanish", "spa");
  const french = task("French", "fra");
  const german = task("German", "deu");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: backend.url,
    transcription_transport: "shared",
    gpu_shared: "1",
    processing_profiles: JSON.stringify([
      {
        id: "review",
        name: "Review workflow",
        folder: "show",
        model: "large-v3",
        language: "en",
        outputFormat: "srt",
        review: true,
        exportNote: true,
        targetTaskIds: [spanish, french, german],
      },
    ]),
  });
  const command = (args: string[]) =>
    promisify(execFile)(process.execPath, ["scripts/subsmelt.mjs", ...args, "--server", appUrl]);
  const submit = ["submit", "--file", video, "--key", "episode-review"];
  try {
    const { plan } = JSON.parse((await command(["plan", "--file", video])).stdout);
    assert.equal(plan.profile.id, "review");
    assert.equal(plan.effective.model, "large-v3");
    assert.equal(plan.settings, undefined);
    const {
      items: [item],
    } = JSON.parse((await command(submit)).stdout);
    await transcriptionWork.idle();
    const pending = transcriptionWork.store.get(item.id);
    assert.equal(pending?.status, "needs_review", pending?.error);
    const source = pending?.outputPath;
    assert.ok(source);
    assert.equal(fs.readFileSync(source, "utf8"), content);
    const reopened = new WorkStore(path.join(process.env.DATA_DIR!, "transcription-work.json"));
    assert.equal(reopened.get(item.id)?.status, "needs_review");
    await assert.rejects(command(["wait", item.id]), (error: unknown) => {
      const exited = error as { code: number; stdout: string };
      return exited.code === 5 && JSON.parse(exited.stdout).status === "needs_review";
    });
    await scanFolder(true);
    assert.equal(getJobBySrtAndTask(source, spanish), undefined);
    assert.equal(getJobBySrtAndTask(source, french), undefined);
    assert.equal(queueFileTranslation(source, { taskId: french }, true).kind, "rejected");

    const review = await (await fetch(`${appUrl}/api/transcribe/work/${item.id}/review`)).json();
    const preview = await fetch(`${appUrl}/api/transcribe/work/${item.id}/review/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: review.revision,
        operations: [
          { kind: "offset", milliseconds: 1000 },
          { kind: "frameRate", from: 24, to: 48 },
        ],
      }),
    });
    assert.equal(preview.status, 200);
    assert.match((await preview.json()).content, /00:00:01,000 --> 00:00:02,000/);
    assert.equal(fs.readFileSync(source, "utf8"), content);
    const stale = await fetch(`${appUrl}/api/transcribe/work/${item.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: "0".repeat(64) }),
    });
    assert.equal(stale.status, 409);

    const edit = path.join(root, "edited.srt");
    fs.writeFileSync(edit, content.replace("Initial dialogue.", "Approved dialogue."));
    updateTask(german, { prompt_override: "Changed after the work was submitted" });
    await command([
      "approve",
      item.id,
      "--targets",
      `${spanish},${german}`,
      "--edit",
      edit,
      "--revision",
      review.revision,
    ]);
    await transcriptionWork.idle();
    const { status, translationIssues } = JSON.parse((await command(["wait", item.id])).stdout);
    assert.equal(status, "succeeded");
    assert.match(translationIssues[0], /German: translation settings changed/);
    assert.match(fs.readFileSync(source, "utf8"), /Approved dialogue/);
    assert.ok(getJobBySrtAndTask(source, spanish));
    assert.equal(getJobBySrtAndTask(source, french), undefined);
    assert.equal(getJobBySrtAndTask(source, german), undefined);
    const saved = new WorkStore(path.join(process.env.DATA_DIR!, "transcription-work.json"));
    assert.equal(saved.allowsAutomaticTranslation(source, video, spanish), true);
    assert.equal(saved.allowsAutomaticTranslation(source, video, french), false);
    assert.equal(saved.allowsAutomaticTranslation(source, video, german), false);
    const downloaded = path.join(root, "note.md");
    await command(["download", item.id, "--note", "--output", downloaded]);
    assert.match(fs.readFileSync(downloaded, "utf8"), /Approved dialogue/);
    const {
      items: [same],
    } = JSON.parse((await command(submit)).stdout);
    assert.equal(same.id, item.id);
    await assert.rejects(command([...submit, "--model", "small"]));
    assert.equal(backend.bodies.length, 1);
    assert.equal(queueFileTranslation(source, { taskId: french }, true).kind, "queued");
    const afterManualTranslation = new WorkStore(path.join(process.env.DATA_DIR!, "transcription-work.json"));
    assert.equal(afterManualTranslation.allowsAutomaticTranslation(source, video, french), true);
  } finally {
    backend.close();
    requestStop();
    setYoutubeBacklogSource(() => 0);
    setSettings({ processing_profiles: "[]", gpu_shared: "0" });
  }
});

test("a queued plan freezes recognition settings and resolves the live backend when run", async () => {
  const backend = await startBackend("/unused");
  setSettings({
    transcription_enabled: "1",
    transcription_backend_url: "http://127.0.0.1:1",
    transcription_model: "small",
    transcription_language: "en",
    transcription_advanced_stt: JSON.stringify({ beam_size: 4 }),
  });
  try {
    const [work] = transcriptionWork.store.enqueue([
      {
        kind: "url",
        input: "https://example.org/frozen-plan",
        request: {},
      },
    ]);
    setSettings({
      transcription_backend_url: backend.url,
      transcription_model: "large-v3",
      transcription_language: "ja",
      transcription_advanced_stt: JSON.stringify({ beam_size: 8 }),
    });
    transcriptionWork.start();
    await transcriptionWork.idle();
    assert.equal(transcriptionWork.store.get(work.id)?.status, "succeeded");
    assert.deepEqual(
      backend.bodies.map(({ model, language, advanced_options }) => ({ model, language, advanced_options })),
      [{ model: "small", language: "en", advanced_options: { beam_size: 4 } }],
    );
  } finally {
    setSettings({ transcription_advanced_stt: "" });
    backend.close();
  }
});
