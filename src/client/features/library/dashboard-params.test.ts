import test from "node:test";
import assert from "node:assert/strict";
import { dashboardHref, parseDashboardParams } from "./dashboard-params";

const parse = (query: string) => parseDashboardParams(new URLSearchParams(query));

test("an empty query is the Jobs view with nothing filtered", () => {
  assert.deepEqual(parse(""), { view: "jobs", status: "all", rows: "jobs", sort: "name-asc", folder: "" });
});

test("known values are read from the query", () => {
  assert.deepEqual(parse("view=jobs&status=error"), {
    view: "jobs",
    status: "error",
    rows: "jobs",
    sort: "name-asc",
    folder: "",
  });
  assert.deepEqual(parse("view=transcriptions"), {
    view: "transcriptions",
    status: "all",
    rows: "jobs",
    sort: "name-asc",
    folder: "",
  });
  assert.deepEqual(parse("status=needsTranscription"), {
    view: "jobs",
    status: "needsTranscription",
    rows: "jobs",
    sort: "name-asc",
    folder: "",
  });
});

test("links to the removed Files view open the Jobs status that shows the same work", () => {
  assert.deepEqual(parse("view=files"), {
    view: "jobs",
    status: "all",
    rows: "files",
    sort: "name-asc",
    folder: "",
  });
  assert.deepEqual(parse("filter=needsTranscription"), {
    view: "jobs",
    status: "needsTranscription",
    rows: "jobs",
    sort: "name-asc",
    folder: "",
  });
  assert.deepEqual(parse("filter=missingLanguage"), {
    view: "jobs",
    status: "notQueued",
    rows: "jobs",
    sort: "name-asc",
    folder: "",
  });
  assert.deepEqual(parse("filter=inProgress"), {
    view: "jobs",
    status: "translating",
    rows: "jobs",
    sort: "name-asc",
    folder: "",
  });
  assert.deepEqual(parse("filter=error&status=done"), {
    view: "jobs",
    status: "done",
    rows: "jobs",
    sort: "name-asc",
    folder: "",
  });
});

test("unknown values fall back to the defaults", () => {
  assert.deepEqual(parse("view=activity&filter=bogus&status=ERROR"), {
    view: "jobs",
    status: "all",
    rows: "jobs",
    sort: "name-asc",
    folder: "",
  });
});

test("hrefs omit defaults", () => {
  assert.equal(dashboardHref({}), "/");
  assert.equal(dashboardHref({ view: "jobs", status: "all", rows: "jobs" }), "/");
  assert.equal(dashboardHref({ view: "jobs", status: "error", rows: "jobs" }), "/?status=error");
  assert.equal(dashboardHref({ view: "transcriptions" }), "/?view=transcriptions");
  assert.equal(dashboardHref({ rows: "files" }), "/?rows=files");
});

test("an href parses back to the state it was built from", () => {
  const state = {
    view: "transcriptions",
    status: "notQueued",
    rows: "files",
    sort: "name-asc",
    folder: "AnKor/Tutorials",
  } as const;
  assert.deepEqual(parse(dashboardHref(state).slice(2)), state);
});

test("a folder is read from the query without stray slashes, and omitted when it is the whole library", () => {
  assert.equal(parse("folder=/AnKor/Tutorials/").folder, "AnKor/Tutorials");
  assert.equal(parse("folder=").folder, "");
  assert.equal(parse("folder=all").folder, "");
  assert.equal(parse("folder=/all/").folder, "");
  assert.equal(dashboardHref({ folder: "" }), "/");
  assert.equal(dashboardHref({ folder: "AnKor" }), "/?folder=AnKor");
});

test("a folder named all has a distinct, round-trippable scope", () => {
  const href = dashboardHref({ folder: "all" });
  assert.equal(href, "/?folder=all&folderScope=path");
  assert.equal(parse(href.slice(2)).folder, "all");
  assert.equal(parse("folder=all%2Fsubfolder").folder, "all/subfolder");
});

test("file sort is validated and round-trips in links", () => {
  assert.equal(parse("rows=files&sort=date-asc").sort, "date-asc");
  assert.equal(parse("sort=invalid").sort, "name-asc");
  assert.equal(dashboardHref({ rows: "files", sort: "name-desc" }), "/?rows=files&sort=name-desc");
  assert.equal(dashboardHref({ sort: "name-asc" }), "/");
});
