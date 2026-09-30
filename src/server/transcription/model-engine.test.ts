import test from "node:test";
import assert from "node:assert/strict";
import { modelEngine } from "./model-engine.js";

test("modelEngine names the engine that runs a model id", () => {
  assert.equal(modelEngine("nemotron-3.5-asr"), "nemotron");
  assert.equal(modelEngine("Nemotron-3.5-ASR"), "nemotron");
  assert.equal(modelEngine("small"), "whisper");
  assert.equal(modelEngine("large-v3-turbo"), "whisper");
  assert.equal(modelEngine("distil-large-v3"), "whisper");
});
