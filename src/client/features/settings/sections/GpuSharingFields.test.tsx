import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../../test-render";
import { GpuSharingFields } from "./GpuSharingFields";

const ignore = () => {};

test("the Convert option stays hidden until the GPU is shared", () => {
  const page = renderPage(<GpuSharingFields settings={{ gpu_shared: "0" }} update={ignore} />);

  assert.ok(page.text.includes("Transcription and translation share one GPU"));
  assert.ok(!page.text.includes("Convert page translations take turns too"));
});

test("a shared GPU offers the Convert option, off by default", () => {
  const page = renderPage(<GpuSharingFields settings={{ gpu_shared: "1" }} update={ignore} />);

  assert.ok(page.text.includes("Convert page translations take turns too"));
  // Only the shared-GPU toggle is ticked.
  assert.equal(page.html.match(/checked=""/g)?.length, 1);
});
