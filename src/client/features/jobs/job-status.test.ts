import test from "node:test";
import assert from "node:assert/strict";
import type { TFunction } from "i18next";
import { jobStatusDescriptor } from "./JobStatusBadge";

const t = ((key: string) => `t:${key}`) as unknown as TFunction;

test("jobStatusDescriptor gives each job status a glyph, a label and a tone", () => {
  assert.deepEqual(jobStatusDescriptor({ status: "skipped", force: 0, priority: 0 }, t), { glyph: "⊘", label: "t:dashboard.status.skipped", tone: "warn" });
  assert.deepEqual(jobStatusDescriptor({ status: "translating", force: 1, priority: 2 }, t), { glyph: "◉", label: "t:dashboard.status.translating ⚡ 📌", tone: "run" });
  assert.deepEqual(jobStatusDescriptor({ status: "pending", force: 0, priority: 0 }, t), { glyph: "○", label: "t:dashboard.status.pending", tone: "neutral" });
});
