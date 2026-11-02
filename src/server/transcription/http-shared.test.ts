import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { StreamingUnsupportedError, postTranscriptionStream } from "./http-shared.js";

interface Scripted {
  status: number;
  body: string;
}

let scripted: Scripted = { status: 200, body: "" };

const server = http.createServer((req, res) => {
  req.resume();
  res.writeHead(scripted.status, { "Content-Type": "application/x-ndjson" });
  res.end(scripted.body);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/transcribe/stream`;
after(() => {
  server.closeAllConnections();
  server.close();
});

function post(): Promise<unknown> {
  return postTranscriptionStream(url, { headers: {}, body: "{}" }, "Transcription", { timeoutSeconds: 2 });
}

async function rejection(): Promise<Error & { backendStatus?: number }> {
  try {
    await post();
  } catch (error: unknown) {
    return error as Error & { backendStatus?: number };
  }
  throw new Error("resolved");
}

test("an error line's status is carried as the backend status", async () => {
  scripted = {
    status: 200,
    body: `${JSON.stringify({ type: "error", error: "pyannote.audio is not installed", code: "diarization_unavailable", status: 400 })}\n`,
  };
  const error = await rejection();
  assert.equal(error.message, "pyannote.audio is not installed");
  assert.equal(error.backendStatus, 400);
});

test("an error line from an older backend without a status reads as 500", async () => {
  scripted = { status: 200, body: `${JSON.stringify({ type: "error", error: "decoder exploded" })}\n` };
  const error = await rejection();
  assert.equal(error.message, "decoder exploded");
  assert.equal(error.backendStatus, 500);
});

test("an error line with an empty message is still a failure, not a missing result", async () => {
  scripted = { status: 200, body: `${JSON.stringify({ type: "error", error: "" })}\n` };
  const error = await rejection();
  assert.equal(error.message, "Transcription failed");
  assert.equal(error.backendStatus, 500);
});

test("a 404 with no error code means the route is missing", async () => {
  scripted = { status: 404, body: JSON.stringify({ detail: "Not Found" }) };
  await assert.rejects(post(), StreamingUnsupportedError);
});

test("a 404 that carries an error code is the backend's answer, not a missing route", async () => {
  scripted = {
    status: 404,
    body: JSON.stringify({ detail: { code: "input_missing", message: "Input media file does not exist" } }),
  };
  const error = await rejection();
  assert.ok(!(error instanceof StreamingUnsupportedError));
  assert.equal(error.message, "Input media file does not exist");
  assert.equal(error.backendStatus, 404);
});
