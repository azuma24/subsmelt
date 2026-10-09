import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../../test-render";
import { findDescriptor } from "../../whisper/whisper-shared";
import { SttDeviceFields } from "./SttAdvancedFields";

const settings = { transcription_device: "cuda", transcription_compute_type: "float16" };
const small = findDescriptor([], "small");
const ignore = () => {};

test("a Mac host shows no device or compute type field", () => {
  const page = renderPage(
    <SttDeviceFields
      settings={settings}
      update={ignore}
      model={small}
      host={{ os: "macos", arch: "arm64", accelerator: "metal", gpuName: "Apple M5 Pro", memoryMb: 49152 }}
    />,
  );

  assert.equal(page.text, "");
});

test("a CUDA host shows the stored device and compute type with today's help", () => {
  const page = renderPage(
    <SttDeviceFields
      settings={settings}
      update={ignore}
      model={small}
      host={{ os: "windows", arch: "x86_64", accelerator: "cuda", gpuName: "RTX 4090", memoryMb: 24564 }}
    />,
  );

  assert.equal(
    page.text,
    "Device CPU is the safe default. External backends may support cuda. Compute type Use int8 for CPU.",
  );
  assert.ok(page.html.includes('value="cuda"'));
  assert.ok(page.html.includes('value="float16"'));
});

test("a backend that predates host keeps both fields", () => {
  const page = renderPage(
    <SttDeviceFields settings={settings} update={ignore} model={small} host={{ os: "unknown", accelerator: "cpu" }} />,
  );

  assert.ok(page.text.startsWith("Device "));
  assert.ok(page.text.includes("Compute type"));
});
