import { test } from "node:test";
import assert from "node:assert/strict";
import { breadcrumbItems, truncateBreadcrumb, ELLIPSIS } from "./breadcrumb";

test("breadcrumbItems for root is just home", () => {
  assert.deepEqual(breadcrumbItems("", "Home"), [{ label: "Home", path: "" }]);
});

test("breadcrumbItems yields one item per ancestor with cumulative paths", () => {
  assert.deepEqual(breadcrumbItems("a/b/c", "Home"), [
    { label: "Home", path: "" },
    { label: "a", path: "a" },
    { label: "b", path: "a/b" },
    { label: "c", path: "a/b/c" },
  ]);
});

test("truncateBreadcrumb leaves short trails untouched", () => {
  const items = breadcrumbItems("a/b", "Home");
  assert.deepEqual(truncateBreadcrumb(items, 4), items);
});

test("truncateBreadcrumb collapses middle segments into an ellipsis", () => {
  const items = breadcrumbItems("a/b/c/d/e", "Home"); // 6 items
  const out = truncateBreadcrumb(items, 4);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { label: "Home", path: "" });
  assert.equal(out[1], ELLIPSIS);
  assert.deepEqual(out[2], { label: "d", path: "a/b/c/d" });
  assert.deepEqual(out[3], { label: "e", path: "a/b/c/d/e" });
});

test("truncateBreadcrumb always keeps home and the last segment", () => {
  const items = breadcrumbItems("a/b/c/d/e/f/g", "Home");
  const out = truncateBreadcrumb(items, 3);
  assert.deepEqual(out[0], { label: "Home", path: "" });
  assert.equal(out[1], ELLIPSIS);
  assert.deepEqual(out[out.length - 1], { label: "g", path: "a/b/c/d/e/f/g" });
});
