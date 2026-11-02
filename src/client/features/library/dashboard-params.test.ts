import test from "node:test";
import assert from "node:assert/strict";
import { dashboardHref, parseDashboardParams } from "./dashboard-params";

const parse = (query: string) => parseDashboardParams(new URLSearchParams(query));

test("an empty query is the Jobs view with nothing filtered", () => {
  assert.deepEqual(parse(""), { view: "jobs", status: "all", rows: "jobs" });
});

test("known values are read from the query", () => {
  assert.deepEqual(parse("view=jobs&status=error"), { view: "jobs", status: "error", rows: "jobs" });
  assert.deepEqual(parse("view=transcriptions"), { view: "transcriptions", status: "all", rows: "jobs" });
  assert.deepEqual(parse("status=needsTranscription"), { view: "jobs", status: "needsTranscription", rows: "jobs" });
});

test("links to the removed Files view open the Jobs status that shows the same work", () => {
  assert.deepEqual(parse("view=files"), { view: "jobs", status: "all", rows: "files" });
  assert.deepEqual(parse("filter=needsTranscription"), { view: "jobs", status: "needsTranscription", rows: "jobs" });
  assert.deepEqual(parse("filter=missingLanguage"), { view: "jobs", status: "notQueued", rows: "jobs" });
  assert.deepEqual(parse("filter=inProgress"), { view: "jobs", status: "translating", rows: "jobs" });
  assert.deepEqual(parse("filter=error&status=done"), { view: "jobs", status: "done", rows: "jobs" });
});

test("unknown values fall back to the defaults", () => {
  assert.deepEqual(parse("view=activity&filter=bogus&status=ERROR"), { view: "jobs", status: "all", rows: "jobs" });
});

test("hrefs omit defaults", () => {
  assert.equal(dashboardHref({}), "/");
  assert.equal(dashboardHref({ view: "jobs", status: "all", rows: "jobs" }), "/");
  assert.equal(dashboardHref({ view: "jobs", status: "error", rows: "jobs" }), "/?status=error");
  assert.equal(dashboardHref({ view: "transcriptions" }), "/?view=transcriptions");
  assert.equal(dashboardHref({ rows: "files" }), "/?rows=files");
});

test("an href parses back to the state it was built from", () => {
  const state = { view: "transcriptions", status: "notQueued", rows: "files" } as const;
  assert.deepEqual(parse(dashboardHref(state).slice(2)), state);
});
