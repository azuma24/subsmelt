import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { UsageReport } from "../shared/usage.js";

// config.ts and db.ts read these at import, so point them at a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-usage-"));
process.env.CONFIG_DIR = path.join(root, "config");
process.env.DATA_DIR = path.join(root, "data");
process.env.MEDIA_DIR = path.join(root, "media");
const { setSetting } = await import("./config.js");
const { recordUsage } = await import("./usage.js");
const { registerUsageRoutes } = await import("./routes/usage.js");

const app = express();
registerUsageRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const getReport = async (range: string): Promise<UsageReport> => {
  const res = await fetch(`${base}/api/usage?range=${range}`);
  assert.equal(res.status, 200);
  return res.json();
};

const DAY_MS = 86_400_000;
const now = new Date();
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const daysAgo = (n: number) => new Date(today - n * DAY_MS + 60_000);
const dayString = (n: number) => daysAgo(n).toISOString().slice(0, 10);

const openai = { id: "openai", label: "OpenAI", provider: "openai" as const, model: "gpt-4o-mini" };
const local = { id: "local", label: "Desk GPU", provider: undefined, model: "qwen3-14b" };
const claude = { id: "claude", label: "Claude", provider: "anthropic" as const, model: "claude-sonnet-4" };
const tokens = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});
const usd = (n: number | null) => (n === null ? null : Number(n.toFixed(6)));

function seed() {
  recordUsage({
    ...tokens(1000, 500),
    cacheReadTokens: 400,
    reasoningTokens: 50,
    kind: "chunk",
    connection: openai,
    jobId: 1,
    srtName: "a.srt",
    ts: daysAgo(0),
  });
  recordUsage({ ...tokens(300, 100), kind: "single", connection: local, jobId: 1, srtName: "a.srt", ts: daysAgo(2) });
  recordUsage({
    ...tokens(2000, 100),
    kind: "analysis",
    connection: openai,
    jobId: 2,
    srtName: "b.srt",
    ts: daysAgo(3),
  });
  recordUsage({
    ...tokens(5000, 1000),
    kind: "convert",
    connection: claude,
    jobId: null,
    srtName: "c.srt",
    ts: daysAgo(10),
  });
}

test("an empty ledger reports zeros, no days and no budget", async () => {
  const report = await getReport("7d");
  assert.equal(report.totals.calls, 0);
  assert.equal(report.totals.costUsd, null);
  assert.equal(report.daily.length, 7);
  assert.ok(report.daily.every((d) => d.calls === 0 && d.costUsd === null));
  assert.equal(report.budget, null);
  assert.deepEqual((await getReport("all")).daily, []);
});

test("7d sums only the last seven UTC days and fills every day", async () => {
  seed();
  const report = await getReport("7d");

  assert.equal(report.range, "7d");
  assert.equal(report.from, new Date(today - 6 * DAY_MS).toISOString());
  assert.deepEqual(
    { ...report.totals, costUsd: usd(report.totals.costUsd) },
    {
      calls: 3,
      inputTokens: 3300,
      outputTokens: 700,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      reasoningTokens: 50,
      totalTokens: 4000,
      costUsd: 0.00081,
      jobs: 2,
      files: 2,
    },
  );

  assert.deepEqual(
    report.daily.map((d) => d.day),
    [6, 5, 4, 3, 2, 1, 0].map(dayString),
  );
  const localOnlyDay = report.daily.find((d) => d.day === dayString(2));
  assert.deepEqual(localOnlyDay, { day: dayString(2), calls: 1, inputTokens: 300, outputTokens: 100, costUsd: null });

  assert.deepEqual(
    report.byModel.map((m) => [m.provider, m.model, m.connectionLabel, m.calls, usd(m.costUsd)]),
    [
      ["openai", "gpt-4o-mini", "OpenAI", 2, 0.00081],
      ["local", "qwen3-14b", "Desk GPU", 1, null],
    ],
  );
  assert.deepEqual(
    report.byKind.map((k) => k.kind),
    ["analysis", "chunk", "single"],
  );
  assert.deepEqual(
    report.topFiles.map((f) => [f.jobId, f.srtName, f.inputTokens + f.outputTokens]),
    [
      [2, "b.srt", 2100],
      [1, "a.srt", 1900],
    ],
  );
  assert.deepEqual(
    report.recent.map((c) => [c.kind, c.srtName]),
    [
      ["analysis", "b.srt"],
      ["single", "a.srt"],
      ["chunk", "a.srt"],
    ],
  );
});

test("all starts at the first call and ranks the biggest model first", async () => {
  const report = await getReport("all");
  assert.equal(report.from, null);
  assert.equal(report.totals.calls, 4);
  assert.equal(usd(report.totals.costUsd), 0.03081);
  assert.equal(report.daily.length, 11);
  assert.equal(report.daily[0].day, dayString(10));
  assert.equal(report.byModel[0].model, "claude-sonnet-4");
  assert.deepEqual(report.topFiles[0], {
    jobId: null,
    srtName: "c.srt",
    calls: 1,
    inputTokens: 5000,
    outputTokens: 1000,
    costUsd: 0.03,
  });
});

test("an unknown range is refused", async () => {
  const res = await fetch(`${base}/api/usage?range=2w`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /range must be one of 7d, 30d, 90d, 365d, all/);
});

test("clearing empties the ledger and says how many calls went", async () => {
  const res = await fetch(`${base}/api/usage`, { method: "DELETE" });
  assert.deepEqual(await res.json(), { ok: true, deleted: 4 });
  assert.equal((await getReport("all")).totals.calls, 0);
});

test("a monthly budget reports this calendar month's tokens", async () => {
  setSetting("monthly_token_budget", "1000");
  recordUsage({ ...tokens(1000, 500), kind: "chunk", connection: openai, jobId: 3, srtName: "d.srt" });
  const { budget } = await getReport("30d");
  assert.deepEqual(
    { ...budget, monthCostUsd: usd(budget?.monthCostUsd ?? null) },
    {
      monthlyTokens: 1000,
      monthTokens: 1500,
      monthCostUsd: 0.00045,
      monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    },
  );
});
