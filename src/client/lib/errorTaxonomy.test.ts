import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, errorHintKey } from "./errorTaxonomy.js";

test("classifies the failures actually seen in the wild", () => {
  // Every string here was copied from a real log line.
  assert.equal(classifyError("fetch failed"), "backend-unreachable");
  assert.equal(classifyError("terminated"), "connection-dropped");
  assert.equal(classifyError("Transcription backend timed out after 300s"), "timeout");
  assert.equal(classifyError("[WinError 2] The system cannot find the file specified"), "server-missing");
  assert.equal(classifyError("did not match schema"), "schema");
  assert.equal(classifyError("Transcription interrupted by server restart"), "interrupted");
});

test("classifies backend preflight refusals", () => {
  assert.equal(classifyError("Transcription preflight failed: insufficient_ram"), "insufficient-ram");
  assert.equal(classifyError("Transcription preflight failed: ffmpeg_missing"), "ffmpeg-missing");
  assert.equal(classifyError("Transcription preflight failed: insufficient_disk"), "insufficient-disk");
  assert.equal(classifyError("model_not_downloaded"), "model-missing");
});

test("classifies provider-side rejections", () => {
  assert.equal(classifyError("401 Unauthorized"), "auth");
  assert.equal(classifyError("Invalid API key provided"), "auth");
  assert.equal(classifyError("429 Too Many Requests"), "rate-limit");
});

test("specific causes win over the generic transport ones", () => {
  // "not downloaded" would otherwise be swallowed by a not-found rule, and a
  // cancelled request often also reports a socket error.
  assert.equal(classifyError("model_not_downloaded: large-v3 is not downloaded"), "model-missing");
  assert.equal(classifyError("The operation was aborted: socket hang up"), "cancelled");
  assert.equal(classifyError("ffmpeg not found, ENOENT"), "ffmpeg-missing");
});

test("matching is case-insensitive", () => {
  assert.equal(classifyError("FETCH FAILED"), "backend-unreachable");
  assert.equal(classifyError("ECONNREFUSED 127.0.0.1:8001"), "backend-unreachable");
});

test("unrecognised and empty input is unknown", () => {
  assert.equal(classifyError("something entirely novel"), "unknown");
  assert.equal(classifyError(""), "unknown");
  assert.equal(classifyError("   "), "unknown");
  assert.equal(classifyError(null), "unknown");
  assert.equal(classifyError(undefined), "unknown");
});

test("unknown has no hint so callers fall back to the raw text", () => {
  assert.equal(errorHintKey("unknown"), null);
  assert.equal(errorHintKey("timeout"), "errors.timeout");
  assert.equal(errorHintKey("backend-unreachable"), "errors.backend-unreachable");
});
