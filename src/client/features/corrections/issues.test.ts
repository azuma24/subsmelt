import test from "node:test";
import assert from "node:assert/strict";
import { issueText } from "./issues";

const t = (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ""}`;

test("an issue is worded through the viewer's translations, prefixed with its list and rule", () => {
  assert.equal(
    issueText({ code: "unstableSelf", list: "Sereniti", find: "AnKor" }, t),
    'Sereniti · “AnKor”: settings.corrections.issue.unstableSelf{"detail":"","lists":"","folder":"settings.corrections.wholeLibrary","find":"AnKor"}',
  );
  assert.equal(
    issueText({ code: "findEmpty", find: "" }, t, { withRule: false }).startsWith(
      "settings.corrections.issue.findEmpty",
    ),
    true,
  );
  assert.match(
    issueText({ code: "listsConflict", lists: ["A", "B"], folder: "TV", find: "x" }, t),
    /"lists":"“A”, “B”","folder":"TV"/,
  );
});
