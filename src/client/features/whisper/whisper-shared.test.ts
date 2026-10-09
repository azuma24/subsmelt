import test from "node:test";
import assert from "node:assert/strict";
import type { TranscriptionHost, WhisperModelDescriptor } from "../../types";
import {
  descriptorsFrom,
  engineLabelKey,
  engineStrengthKey,
  findDescriptor,
  groupByEngine,
  hidesOptions,
  modelEngine,
  supportsLanguage,
} from "./whisper-shared";

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

const macHost: TranscriptionHost = {
  os: "macos",
  arch: "arm64",
  accelerator: "metal",
  gpuName: "Apple M5 Pro",
  memoryMb: 49152,
};
const cudaHost: TranscriptionHost = {
  os: "windows",
  arch: "x86_64",
  accelerator: "cuda",
  gpuName: "NVIDIA GeForce RTX 4090",
  memoryMb: 24564,
};
const legacyHost: TranscriptionHost = { os: "unknown", accelerator: "cuda" };
const oneOfEach = [
  { id: "nemotron-3.5-asr", engine: "nemotron" as const },
  { id: "small", engine: "whisper" as const },
  { id: "whispercpp-large-v3-turbo", engine: "whispercpp" as const },
];

test("groupByEngine leads with the Metal engines on a Mac host", () => {
  assert.deepEqual(
    groupByEngine(oneOfEach, macHost).map((g) => [g.engine, g.items.map((i) => i.id)]),
    [
      ["whispercpp", ["whispercpp-large-v3-turbo"]],
      ["nemotron", ["nemotron-3.5-asr"]],
      ["whisper", ["small"]],
    ],
  );
});

test("groupByEngine orders faster-whisper first on a CUDA or legacy host and drops empty engines", () => {
  for (const host of [cudaHost, legacyHost]) {
    assert.deepEqual(
      groupByEngine(oneOfEach, host).map((g) => g.engine),
      ["whisper", "whispercpp", "nemotron"],
    );
  }
  assert.deepEqual(
    groupByEngine([{ id: "small", engine: "whisper" as const }], cudaHost).map((g) => g.engine),
    ["whisper"],
  );
});

test("engineLabelKey calls faster-whisper Whisper (CPU) only on a Mac host", () => {
  assert.equal(engineLabelKey("whisper", macHost), "stt.engine.whisperCpu");
  assert.equal(engineLabelKey("whisper", cudaHost), "stt.engine.whisper");
  assert.equal(engineLabelKey("whispercpp", macHost), "stt.engine.whispercpp");
  assert.equal(engineStrengthKey("whisper", macHost), "stt.engineStrength.whisperCpu");
  assert.equal(engineStrengthKey("whisper", legacyHost), "stt.engineStrength.whisper");
  assert.equal(engineStrengthKey("nemotron", macHost), "stt.engineStrength.nemotron");
});

test("modelEngine maps whispercpp ids to the whisper.cpp engine", () => {
  assert.equal(modelEngine("whispercpp-large-v3-turbo"), "whispercpp");
  assert.equal(modelEngine("nemotron-3.5-asr"), "nemotron");
  assert.equal(modelEngine("small"), "whisper");
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
