import { test } from "node:test";
import assert from "node:assert/strict";
import { setNotifyEvent } from "./notify-events";

test("turning an event on appends it once", () => {
  assert.equal(
    setNotifyEvent("job:error,queue:finished", "youtube:note", true),
    "job:error,queue:finished,youtube:note",
  );
  assert.equal(setNotifyEvent("job:error, youtube:note", "youtube:note", true), "job:error,youtube:note");
});

test("turning an event off keeps the others, including ones the list does not offer", () => {
  assert.equal(setNotifyEvent("job:error,custom:thing,youtube:note", "job:error", false), "custom:thing,youtube:note");
  assert.equal(setNotifyEvent("", "job:done", false), "");
});
