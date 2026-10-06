import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, fetchJSON, getSettings, saveSettings } from "./api.js";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

test("fetchJSON omits JSON content-type for bodyless GET requests and forwards abort signals", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return jsonResponse({ ok: true });
  };

  try {
    const data = await getSettings({ signal: controller.signal });

    assert.deepEqual(data, { ok: true });
    assert.equal(captured?.signal, controller.signal);
    assert.equal(new Headers(captured?.headers).has("Content-Type"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchJSON sends JSON content-type when a request body is present", async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return jsonResponse({ ok: true });
  };

  try {
    await saveSettings({ model: "tiny" });

    assert.equal(new Headers(captured?.headers).get("Content-Type"), "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchJSON throws ApiError with HTTP status and safe server message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: "Bad settings" }, { status: 422 });

  try {
    await assert.rejects(
      fetchJSON("/settings"),
      (error) => error instanceof ApiError && error.status === 422 && error.message === "Bad settings",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
