import test from "node:test";
import assert from "node:assert/strict";
import type { TFunction } from "i18next";
import { jobStatusDescriptor } from "./JobStatusBadge";

const t = ((key: string) => `t:${key}`) as unknown as TFunction;

test("jobStatusDescriptor gives each job status a glyph, a label and a tone", () => {
  assert.deepEqual(jobStatusDescriptor({ status: "skipped", force: 0, priority: 0 }, t), {
    glyph: { icon: "skipped" },
    label: "t:dashboard.status.skipped",
    tone: "warn",
    flags: [],
  });
  assert.deepEqual(jobStatusDescriptor({ status: "pending", force: 0, priority: 0 }, t), {
    glyph: { icon: "pending" },
    label: "t:dashboard.status.pending",
    tone: "neutral",
    flags: [],
  });
});

test("forced and pinned jobs carry labelled flags instead of emoji in the label", () => {
  assert.deepEqual(jobStatusDescriptor({ status: "translating", force: 1, priority: 2 }, t), {
    glyph: { icon: "running" },
    label: "t:dashboard.status.translating",
    tone: "run",
    flags: [
      { icon: "forced", label: "t:app.forceEnabled" },
      { icon: "pinned", label: "t:app.pinned" },
    ],
  });
});

test("an unknown status falls back to its raw name with no glyph", () => {
  assert.deepEqual(jobStatusDescriptor({ status: "archived", force: 0, priority: 0 }, t), {
    glyph: "",
    label: "archived",
    tone: "neutral",
    flags: [],
  });
});
