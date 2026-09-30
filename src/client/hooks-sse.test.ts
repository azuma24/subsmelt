import test from "node:test";
import assert from "node:assert/strict";
import {
  getSSEInvalidationKeys,
  parseSSEData,
  createDebouncedInvalidator,
  withVideoProgress,
} from "./hooks.js";
import type { YoutubeVideo } from "./types.js";

test("parseSSEData returns parsed object payloads and ignores invalid JSON", () => {
  assert.deepEqual(parseSSEData('{"jobId":123,"status":"done"}'), { jobId: 123, status: "done" });
  assert.deepEqual(parseSSEData("[]"), {});
  assert.deepEqual(parseSSEData("not-json"), {});
});

test("SSE invalidation keys are targeted by event type", () => {
  assert.deepEqual(getSSEInvalidationKeys("job:progress"), [["jobs"], ["queue-status"]]);
  assert.deepEqual(getSSEInvalidationKeys("job:done"), [["jobs"], ["queue-status"], ["logs"], ["transcription-history"]]);
  assert.deepEqual(getSSEInvalidationKeys("scan:complete"), [["jobs"], ["queue-status"], ["logs"], ["settings"], ["transcription-history"]]);
  assert.deepEqual(getSSEInvalidationKeys("youtube:playlist"), [["youtube"]]);
  assert.deepEqual(getSSEInvalidationKeys("youtube:video"), [["youtube", "playlists"], ["youtube", "videos"]]);
  assert.deepEqual(getSSEInvalidationKeys("youtube:cooldown"), [["youtube", "status"]]);
});

test("a youtube:video progress tick patches only the matching cached row", () => {
  const row = (video_id: string, status: YoutubeVideo["status"]) => ({ video_id, status }) as YoutubeVideo;
  const patched = withVideoProgress({ videos: [row("qD0_yWgifDM", "queued"), row("uXspbC2srEQ", "queued")] }, "qD0_yWgifDM", 42);
  assert.deepEqual(patched?.videos.map((v) => [v.video_id, v.status, v.pct]), [
    ["qD0_yWgifDM", "downloading", 42],
    ["uXspbC2srEQ", "queued", undefined],
  ]);
  assert.equal(withVideoProgress(undefined, "qD0_yWgifDM", 42), undefined);
});

test("createDebouncedInvalidator batches duplicate keys until flushed", () => {
  const invalidated: ReadonlyArray<unknown>[] = [];
  const invalidator = createDebouncedInvalidator((queryKey) => invalidated.push(queryKey), 250);

  invalidator.schedule([["jobs"], ["queue-status"]]);
  invalidator.schedule([["jobs"], ["logs"]]);

  assert.deepEqual(invalidated, []);
  invalidator.flush();
  assert.deepEqual(invalidated, [["jobs"], ["queue-status"], ["logs"]]);
});
