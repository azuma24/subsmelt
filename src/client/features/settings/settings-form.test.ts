import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_FORM, edit, editMany, isDirty, receiveServer, saved, view } from "./settings-form.js";

const base = receiveServer(EMPTY_FORM, { model: "gpt", scan_interval: "60", _watcher_running: false });

test("a refetch keeps unsaved edits and takes server changes for untouched keys", () => {
  const form = edit(base, "model", "claude");
  const refetched = receiveServer(form, { model: "gpt", scan_interval: "120", _watcher_running: false });
  assert.deepEqual(view(refetched), { model: "claude", scan_interval: "120", _watcher_running: false });
  assert.equal(isDirty(refetched), true);
});

test("a save that resolves after a newer edit leaves the form dirty", () => {
  const first = edit(base, "model", "claude");
  const body = view(first);
  const second = edit(first, "model", "gemini");
  const afterSave = saved(second, body);
  assert.equal(isDirty(afterSave), true);
  assert.equal(view(afterSave).model, "gemini");
  assert.deepEqual(saved(afterSave, view(afterSave)).edits, {});
});

test("a successful save clears only the edits it carried", () => {
  const form = editMany(base, { model: "claude", scan_interval: "30" });
  const afterSave = saved(form, view(form));
  assert.equal(isDirty(afterSave), false);
  assert.deepEqual(afterSave.server, { model: "claude", scan_interval: "30", _watcher_running: false });
});

test("editing a key back to the server value is not an unsaved change", () => {
  const form = edit(edit(base, "model", "claude"), "model", "gpt");
  assert.equal(isDirty(form), false);
  assert.deepEqual(form.edits, {});
});

test("server-side state can change underneath edits without dropping them", () => {
  const form = edit(base, "scan_interval", "5");
  const toggled = receiveServer(form, { ...form.server, _watcher_running: true });
  assert.deepEqual(view(toggled), { model: "gpt", scan_interval: "5", _watcher_running: true });
  assert.equal(isDirty(toggled), true);
});
