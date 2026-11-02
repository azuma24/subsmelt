import test from "node:test";
import assert from "node:assert/strict";
import { dashboardHref, parseDashboardParams } from "./dashboard-params";

const parse = (query: string) => parseDashboardParams(new URLSearchParams(query));

test("an empty query is the Jobs view with nothing filtered", () => {
  assert.deepEqual(parse(""), { view: "jobs", status: "all" });
});

test("known values are read from the query", () => {
  assert.deepEqual(parse("view=jobs&status=error"), { view: "jobs", status: "error" });
  assert.deepEqual(parse("view=transcriptions"), { view: "transcriptions", status: "all" });
  assert.deepEqual(parse("status=needsTranscription"), { view: "jobs", status: "needsTranscription" });
});

test("links to the removed Files view open the Jobs status that shows the same work", () => {
  assert.deepEqual(parse("view=files"), { view: "jobs", status: "all" });
  assert.deepEqual(parse("filter=needsTranscription"), { view: "jobs", status: "needsTranscription" });
  assert.deepEqual(parse("filter=missingLanguage"), { view: "jobs", status: "notQueued" });
  assert.deepEqual(parse("filter=inProgress"), { view: "jobs", status: "translating" });
  assert.deepEqual(parse("filter=error&status=done"), { view: "jobs", status: "done" });
});

test("unknown values fall back to the defaults", () => {
  assert.deepEqual(parse("view=activity&filter=bogus&status=ERROR"), { view: "jobs", status: "all" });
});

test("hrefs omit defaults", () => {
  assert.equal(dashboardHref({}), "/");
  assert.equal(dashboardHref({ view: "jobs", status: "all" }), "/");
  assert.equal(dashboardHref({ view: "jobs", status: "error" }), "/?status=error");
  assert.equal(dashboardHref({ view: "transcriptions" }), "/?view=transcriptions");
});

test("an href parses back to the state it was built from", () => {
  const state = { view: "transcriptions", status: "notQueued" } as const;
  assert.deepEqual(parse(dashboardHref(state).slice(2)), state);
});
