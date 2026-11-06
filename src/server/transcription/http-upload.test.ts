import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { transcribeFileWithBackendUpload } from "./http-upload.js";
import type { BackendTranscriptionRequest } from "./types.js";

const ffmpeg = process.env.SUBSMELT_FFMPEG || "ffmpeg";
const ffmpegAvailable = spawnSync(ffmpeg, ["-version"]).status === 0;

function runFfmpeg(...args: string[]): Buffer {
  const process = spawnSync(ffmpeg, ["-v", "error", ...args], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(process.status, 0, process.stderr?.toString());
  return process.stdout;
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "subsmelt-upload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function backend(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<string> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function uploadForm(request: IncomingMessage): Promise<FormData> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return new Response(Buffer.concat(chunks), {
    headers: { "content-type": request.headers["content-type"] ?? "" },
  }).formData();
}

function transcriptionRequest(input_path: string): BackendTranscriptionRequest {
  return {
    input_path,
    model: "small",
    language: "auto",
    device: "cpu",
    compute_type: "int8",
    output_format: "srt",
    use_vad: true,
    post_action: "transcribe_only",
  };
}

test("an audio-only upload to a legacy backend keeps the selected track and its media offset", {
  skip: !ffmpegAvailable,
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "movie.mkv");
  const captured = path.join(directory, "captured.flac");
  runFfmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=size=160x90:rate=20:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=4",
    "-itsoffset",
    "1.25",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1100:sample_rate=48000:duration=2.5",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "2:a",
    "-c:v",
    "mpeg4",
    "-c:a",
    "pcm_s16le",
    source,
  );
  const calls: string[] = [];
  const url = await backend(t, async (request, response) => {
    calls.push(request.url ?? "");
    const form = await uploadForm(request);
    response.setHeader("content-type", "application/json");
    if (request.url === "/transcribe/upload/stream") {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: "Not Found" }));
      return;
    }
    const fields = JSON.parse(String(form.get("request")));
    const file = form.get("file");
    assert(file instanceof File);
    assert.equal(file.name, "audio.flac");
    assert.equal(fields.audio_stream_index, undefined);
    assert.equal(fields.source_audio_stream_index, 2);
    await writeFile(captured, Buffer.from(await file.arrayBuffer()));
    response.end(JSON.stringify({ ok: true, content: "subtitle" }));
  });
  let sentBytes = 0;
  const result = await transcribeFileWithBackendUpload(
    url,
    {
      ...transcriptionRequest(source),
      audio_stream_index: 2,
    },
    source,
    {
      audioOnlyUpload: true,
      onUploadPrepared(bytes, audioOnly) {
        assert.equal(audioOnly, true);
        sentBytes = bytes;
      },
    },
  );
  assert.equal(result.content, "subtitle");
  assert.deepEqual(calls, ["/transcribe/upload/stream", "/transcribe/upload"]);
  assert(sentBytes > 0 && sentBytes < (await stat(source)).size);

  const packed = runFfmpeg("-i", captured, "-f", "s16le", "-");
  const original = runFfmpeg(
    "-i",
    source,
    "-map",
    "0:2",
    "-af",
    "aresample=16000:async=1:first_pts=0",
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "-",
  );
  assert.deepEqual(packed, original);
  assert(packed.subarray(0, 2 * 16_000).every((sample) => sample === 0));
  assert(packed.subarray(2 * 16_000 * 2).some((sample) => sample !== 0));
});

test("a backend without stream-selection support cannot silently use another track", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "movie.mkv");
  await writeFile(source, "input");
  const calls: string[] = [];
  const url = await backend(t, (request, response) => {
    calls.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await assert.rejects(
    transcribeFileWithBackendUpload(url, { ...transcriptionRequest(source), audio_stream_index: 0 }, source, {}),
    /backend does not support selecting an audio stream/,
  );
  assert.deepEqual(calls, ["/health"]);
});

test("automatic upload falls back to the original media when local packing fails", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "movie.mkv");
  await writeFile(source, "unpackable media");
  const url = await backend(t, async (request, response) => {
    assert.equal(request.url, "/transcribe/upload/stream");
    const form = await uploadForm(request);
    const file = form.get("file");
    assert(file instanceof File);
    assert.equal(file.name, "movie.mkv");
    assert.equal(await file.text(), "unpackable media");
    response.setHeader("content-type", "application/x-ndjson");
    response.end(
      `${JSON.stringify({ type: "timing", timings_ms: { asr: 3 }, checkpoint_hit: false })}\n` +
        `${JSON.stringify({ type: "result", ok: true, content: "subtitle" })}\n`,
    );
  });
  let preparation: number | undefined;
  let asr: number | undefined;
  const result = await transcribeFileWithBackendUpload(url, transcriptionRequest(source), source, {
    audioOnlyUpload: true,
    onMetrics({ timingsMs }) {
      preparation ??= timingsMs.uploadPrepare;
      asr ??= timingsMs.asr;
    },
    onUploadPrepared(bytes, audioOnly) {
      assert.equal(bytes, Buffer.byteLength("unpackable media"));
      assert.equal(audioOnly, false);
    },
  });
  assert.equal(result.content, "subtitle");
  assert.equal(typeof preparation, "number");
  assert.equal(asr, 3);
});
