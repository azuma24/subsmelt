import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  transcribeUrlWithBackendStreaming,
  transcribeWithBackendStreaming,
  transcribeWithBackendUploadStreaming,
} from "../transcription-client.js";
import type { BackendTranscriptionRequest, TranscribeStreamingOptions } from "./types.js";

const LINE_EVERY_MS = 40;
const IDLE_TIMEOUT_S = 0.2;

interface Script {
  /** Progress lines to send before the result. */
  lines: number;
  /** Stops sending after this many lines and never answers. */
  stallAfter?: number;
  /** The media length the progress lines report. */
  totalSeconds?: number;
}

let script: Script = { lines: 0 };

const server = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  let sent = 0;
  const timer = setInterval(() => {
    if (script.stallAfter !== undefined && sent >= script.stallAfter) return;
    if (sent >= script.lines) {
      clearInterval(timer);
      res.end(`${JSON.stringify({ type: "result", ok: true, content: "x", language: "en", segments: 1 })}\n`);
      return;
    }
    sent += 1;
    const totalSeconds = script.totalSeconds ?? 3600;
    res.write(`${JSON.stringify({ type: "progress", pct: sent, processedSeconds: sent, totalSeconds })}\n`);
  }, LINE_EVERY_MS);
  res.on("close", () => clearInterval(timer));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const backendUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

const media = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-stream-timeout-")), "a.mkv");
fs.writeFileSync(media, "video");
const request: BackendTranscriptionRequest = {
  input_path: media, output_format: "srt", model: "small", language: "en", device: "cpu", compute_type: "int8", use_vad: true, post_action: "transcribe_only",
};

const transports: Array<[string, (options: TranscribeStreamingOptions) => Promise<unknown>]> = [
  ["shared", (options) => transcribeWithBackendStreaming(backendUrl, request, options)],
  ["upload", (options) => transcribeWithBackendUploadStreaming(backendUrl, request, media, options)],
  ["url", (options) => transcribeUrlWithBackendStreaming(backendUrl, { url: "https://example.com/v" }, options)],
];

for (const [name, run] of transports) {
  test(`${name}: a run that keeps reporting progress outlives the timeout`, async () => {
    // 15 lines, 40 ms apart: 600 ms in all, three times the 200 ms timeout.
    script = { lines: 15 };
    const result = await run({ timeoutSeconds: IDLE_TIMEOUT_S });
    assert.equal((result as { content?: string }).content, "x");
  });

  test(`${name}: a run that goes quiet times out`, async () => {
    script = { lines: 15, stallAfter: 2 };
    await assert.rejects(run({ timeoutSeconds: IDLE_TIMEOUT_S }), /timed out .*without progress/);
  });

  test(`${name}: a run still reporting progress stops at the ceiling set by the media length`, async () => {
    // A 0.01 s video gets a ceiling of the timeout plus ten times its length: 300 ms.
    script = { lines: 50, totalSeconds: 0.01 };
    const startedAt = Date.now();
    await assert.rejects(run({ timeoutSeconds: IDLE_TIMEOUT_S }), /timed out/);
    assert.ok(Date.now() - startedAt < 1500);
  });
}
