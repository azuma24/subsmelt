import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, SeededError } from "../../test-render";
import type { UsageReport } from "../../types";
import { UsagePage } from "./UsagePage";

const report: UsageReport = {
  range: "30d",
  from: "2026-09-08T00:00:00.000Z",
  to: "2026-10-07T12:00:00.000Z",
  totals: {
    calls: 42,
    inputTokens: 120_000,
    outputTokens: 30_000,
    cacheReadTokens: 50_000,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 150_000,
    costUsd: 1.25,
    jobs: 3,
    files: 2,
  },
  budget: null,
  daily: [
    { day: "2026-10-05", calls: 10, inputTokens: 20_000, outputTokens: 5_000, costUsd: 0.2 },
    { day: "2026-10-06", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    { day: "2026-10-07", calls: 32, inputTokens: 100_000, outputTokens: 25_000, costUsd: 1.05 },
  ],
  byModel: [
    {
      provider: "openai",
      model: "gpt-4o-mini",
      connectionLabel: "OpenAI",
      calls: 40,
      inputTokens: 110_000,
      outputTokens: 28_000,
      costUsd: 1.25,
    },
    {
      provider: "local",
      model: "qwen3-14b",
      connectionLabel: "Desk GPU",
      calls: 2,
      inputTokens: 10_000,
      outputTokens: 2_000,
      costUsd: null,
    },
  ],
  byKind: [
    { kind: "chunk", calls: 30, inputTokens: 100_000, outputTokens: 25_000, costUsd: 1 },
    { kind: "single", calls: 12, inputTokens: 20_000, outputTokens: 5_000, costUsd: 0.25 },
  ],
  topFiles: [
    { jobId: 7, srtName: "Show.S01E01.srt", calls: 30, inputTokens: 90_000, outputTokens: 20_000, costUsd: 1 },
  ],
  recent: [
    {
      ts: "2026-10-07T11:59:00.000Z",
      jobId: 7,
      srtName: "Show.S01E01.srt",
      kind: "chunk",
      model: "gpt-4o-mini",
      inputTokens: 3_000,
      outputTokens: 700,
      costUsd: 0.01,
    },
  ],
};

const render = (data: unknown, opts?: { isMobile?: boolean }) =>
  renderPage(<UsagePage />, [[["usage", "30d"], data]], opts);

test("the report's totals, chart legend and breakdowns are on the page", () => {
  const page = render(report);

  assert.ok(page.headings.includes("Usage"));
  for (const text of [
    "Total tokens 150.0k",
    "Input 120.0k 50.0k from cache",
    "Est. cost ≈ $1.25",
    "LLM calls 42",
    "Files 2",
    "Tokens per day",
    "Cost per day",
    "Local qwen3-14b 12.0k Desk GPU · 2 calls 10.0k in · 2,000 out · —",
    "Single line",
    "Show.S01E01.srt",
  ]) {
    assert.ok(page.text.includes(text), `missing "${text}"`);
  }
  assert.match(page.html, /<li[^>]*><span[^>]*bg-chart-1[^>]*><\/span>Input<\/li>/);
  assert.match(page.html, /<li[^>]*><span[^>]*bg-chart-2[^>]*><\/span>Output<\/li>/);
  assert.match(page.html, /<button[^>]*aria-expanded="false"[^>]*>Show table<\/button>/);
  assert.match(
    page.html,
    /role="img" aria-label="Tokens per day from 2026-10-05 to 2026-10-07: 150.0k in total, peak 125.0k on 2026-10-07."/,
  );
  assert.ok(page.buttons.includes("30d"));
  assert.match(page.html, /aria-pressed="true"[^>]*>30d<\/button>/);
});

test("the cost chart is left out when no day has a cost", () => {
  const local = { ...report, daily: report.daily.map((d) => ({ ...d, costUsd: null })) };
  const page = render({ ...local, totals: { ...report.totals, costUsd: null } });

  assert.ok(!page.text.includes("Cost per day"));
  assert.ok(page.text.includes("Est. cost n/a Local and unpriced models have no cost estimate"));
});

test("a month over its token budget says so", () => {
  const page = render({
    ...report,
    budget: {
      monthlyTokens: 100_000,
      monthTokens: 150_000,
      monthCostUsd: 1.25,
      monthStart: "2026-10-01T00:00:00.000Z",
    },
  });

  assert.ok(page.text.includes("Over budget 150.0k of 100.0k this month"));
  assert.match(page.html, /text-danger[^"]*">150.0k</);
});

test("an empty ledger explains how it fills", () => {
  const page = render({ ...report, totals: { ...report.totals, calls: 0 } });

  assert.ok(page.text.includes("No LLM calls in this time range"));
  assert.ok(page.text.includes("The ledger fills as translations run."));
  assert.ok(!page.text.includes("Tokens per day"));
});

test("a failed load shows the error with a retry", () => {
  const page = render(new SeededError("server unreachable"));

  assert.ok(page.text.includes("Could not load usage: server unreachable"));
  assert.ok(page.buttons.includes("Retry"));
});

test("phones get stacked rows instead of tables", () => {
  const page = render(report, { isMobile: true });

  assert.doesNotMatch(page.html, /<table/);
  assert.ok(page.text.includes("Show.S01E01.srt 30 calls · 90.0k in · 20.0k out · $1.00"));
});
