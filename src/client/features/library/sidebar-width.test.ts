import test from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR_WIDTH, clampSidebarWidth, parseStoredWidth, sidebarMaxWidth, widthAfterKey } from "./sidebar-width.js";

test("a drag stops at 100px and at 480px on a wide window", () => {
  assert.equal(clampSidebarWidth(40, 1920), 100);
  assert.equal(clampSidebarWidth(300, 1920), 300);
  assert.equal(clampSidebarWidth(900, 1920), 480);
});

test("a small window keeps 60% for the jobs table", () => {
  assert.equal(clampSidebarWidth(480, 1000), 400);
});

test("a saved width is used; anything else falls back to the default", () => {
  assert.equal(parseStoredWidth("320"), 320);
  assert.equal(parseStoredWidth("40"), 100);
  assert.equal(parseStoredWidth("9000"), 480);
  assert.equal(parseStoredWidth(null), SIDEBAR_WIDTH.default);
  assert.equal(parseStoredWidth(""), SIDEBAR_WIDTH.default);
  assert.equal(parseStoredWidth("wide"), SIDEBAR_WIDTH.default);
});

test("arrow keys step the width; Home and End jump to the limits", () => {
  assert.equal(widthAfterKey("ArrowRight", 256, 1920), 272);
  assert.equal(widthAfterKey("ArrowLeft", 256, 1920), 240);
  assert.equal(widthAfterKey("ArrowLeft", 104, 1920), 100);
  assert.equal(widthAfterKey("Home", 256, 1920), 100);
  assert.equal(widthAfterKey("End", 256, 1920), 480);
  assert.equal(widthAfterKey("End", 256, 1000), 400);
  assert.equal(widthAfterKey("Enter", 256, 1920), null);
});

test("the most a window allows is what it can show", () => {
  assert.equal(sidebarMaxWidth(768), 307);
  assert.equal(sidebarMaxWidth(1920), 480);
  assert.equal(sidebarMaxWidth(200), 100);
});
