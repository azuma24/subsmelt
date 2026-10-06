import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOBILE_BREAKPOINT_PX,
  MOBILE_MAX_INLINE_DEPTH,
  INDENT_PER_LEVEL_PX,
  indentPx,
  folderRowMode,
} from "./responsive";

test("breakpoint matches the app-wide 768px boundary", () => {
  assert.equal(MOBILE_BREAKPOINT_PX, 768);
});

test("indentPx grows per level on desktop", () => {
  assert.equal(indentPx(0, false), 0);
  assert.equal(indentPx(3, false), 3 * INDENT_PER_LEVEL_PX);
});

test("indentPx is capped at two levels on mobile", () => {
  assert.equal(indentPx(1, true), INDENT_PER_LEVEL_PX);
  assert.equal(indentPx(2, true), 2 * INDENT_PER_LEVEL_PX);
  assert.equal(indentPx(5, true), 2 * INDENT_PER_LEVEL_PX);
});

test("folders render inline on desktop at any depth", () => {
  assert.equal(folderRowMode(0, false), "inline");
  assert.equal(folderRowMode(7, false), "inline");
});

test("on mobile, folders at depth >= 2 become drill-down rows", () => {
  assert.equal(folderRowMode(0, true), "inline");
  assert.equal(folderRowMode(1, true), "inline");
  assert.equal(folderRowMode(MOBILE_MAX_INLINE_DEPTH, true), "drill");
  assert.equal(folderRowMode(4, true), "drill");
});
