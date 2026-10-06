import test from "node:test";
import assert from "node:assert/strict";
import type { WhisperModelDescriptor } from "../../types";
import { descriptorsFrom, findDescriptor, groupByEngine, hidesOptions, supportsLanguage } from "./whisper-shared";

const nemotron: WhisperModelDescriptor = {
  id: "nemotron-3.5-asr",
  engine: "nemotron",
  label: "Nemotron 3.5 ASR",
  languages: ["en", "ja", "zh", "pt-BR"],
  supports: {
    prompt: false,
    beamSize: false,
    conditionOnPreviousText: false,
    vad: false,
    computeType: false,
    wordTimestamps: true,
    translateTask: false,
  },
  available: false,
  unavailableReason: "nemo-speech runtime not found",
};

test("descriptorsFrom uses the backend's modelInfo when it sends one", () => {
  assert.deepEqual(descriptorsFrom({ models: ["small", "nemotron-3.5-asr"], modelInfo: [nemotron] }), [nemotron]);
});

test("descriptorsFrom synthesizes descriptors from a plain id list", () => {
  const [small, nemo] = descriptorsFrom({ models: ["small", "nemotron-3.5-asr"] });
  assert.deepEqual(small, {
    id: "small",
    engine: "whisper",
    label: "small",
    languages: "all",
    supports: {
      prompt: true,
      beamSize: true,
      conditionOnPreviousText: true,
      vad: true,
      computeType: true,
      wordTimestamps: true,
      translateTask: true,
    },
    available: true,
    unavailableReason: null,
  });
  assert.equal(nemo?.engine, "nemotron");
  assert.equal(descriptorsFrom(undefined).length, 9);
});

test("findDescriptor synthesizes a saved model the backend does not list", () => {
  assert.equal(findDescriptor([nemotron], "nemotron-3.5-asr"), nemotron);
  assert.equal(findDescriptor([nemotron], "large-v2").engine, "whisper");
});

test("groupByEngine orders Whisper first and drops empty engines", () => {
  const groups = groupByEngine([
    { id: "nemotron-3.5-asr", engine: "nemotron" as const },
    { id: "small", engine: "whisper" as const },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.engine, g.items.map((i) => i.id)]),
    [
      ["whisper", ["small"]],
      ["nemotron", ["nemotron-3.5-asr"]],
    ],
  );
  assert.deepEqual(
    groupByEngine([{ id: "small", engine: "whisper" as const }]).map((g) => g.engine),
    ["whisper"],
  );
});

test("supportsLanguage checks the model's language list, case-insensitively, and always allows auto", () => {
  assert.equal(supportsLanguage(nemotron, "zh-TW"), false);
  assert.equal(supportsLanguage(nemotron, "pt-br"), true);
  assert.equal(supportsLanguage(nemotron, "auto"), true);
  assert.equal(supportsLanguage(findDescriptor([], "small"), "zh-TW"), true);
});

test("hidesOptions is true only when the model decides a decoding option itself", () => {
  assert.equal(hidesOptions(nemotron), true);
  assert.equal(hidesOptions(findDescriptor([], "small")), false);
});
