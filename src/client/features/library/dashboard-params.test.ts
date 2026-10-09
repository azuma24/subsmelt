import test from "node:test";
import assert from "node:assert/strict";
import { dashboardHref, parseDashboardParams } from "./dashboard-params";

const parse = (query: string) => parseDashboardParams(new URLSearchParams(query));

test("an empty query is the Files view with nothing filtered", () => {
  assert.deepEqual(parse(""), { view: "files", filter: "all", status: "all" });
});

test("known values are read from the query", () => {
  assert.deepEqual(parse("view=jobs&status=error"), { view: "jobs", filter: "all", status: "error" });
  assert.deepEqual(parse("view=transcriptions"), { view: "transcriptions", filter: "all", status: "all" });
  assert.deepEqual(parse("filter=needsTranscription"), { view: "files", filter: "needsTranscription", status: "all" });
});

test("unknown values fall back to the defaults", () => {
  assert.deepEqual(parse("view=activity&filter=bogus&status=ERROR"), { view: "files", filter: "all", status: "all" });
});

test("hrefs omit defaults", () => {
  assert.equal(dashboardHref({}), "/");
  assert.equal(dashboardHref({ view: "files", filter: "all", status: "all" }), "/");
  assert.equal(dashboardHref({ view: "jobs", status: "error" }), "/?view=jobs&status=error");
  assert.equal(dashboardHref({ view: "jobs" }), "/?view=jobs");
  assert.equal(dashboardHref({ filter: "done" }), "/?filter=done");
});

test("an href parses back to the state it was built from", () => {
  const state = { view: "jobs", filter: "error", status: "pending" } as const;
  assert.deepEqual(parse(dashboardHref(state).slice(2)), state);
});
