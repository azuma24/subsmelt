import test from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import en from "../locales/en/translation.json";
import { connectionStateText, summarizeLlmStatus } from "./llm-status-summary";
import type { LlmConnectionStatus, LlmStatus } from "../types";

const i18nInstance = i18n.createInstance();
await i18nInstance.init({ resources: { en: { translation: en } }, lng: "en", interpolation: { escapeValue: false } });
const t = i18nInstance.t.bind(i18nInstance);

const conn = (id: string, state: LlmConnectionStatus["state"], jobIds: number[] = []): LlmConnectionStatus => ({
  id,
  label: `Box ${id}`,
  model: `model-${id}`,
  host: `${id}.lan:1234`,
  state,
  jobIds,
});

const summary = (status: LlmStatus | undefined, failed = false) => {
  const { tone, text } = summarizeLlmStatus(status, failed, t);
  return { tone, text };
};

test("idle pools name the mode and count, or the one connection's label and model", () => {
  assert.deepEqual(summary({ mode: "fallback", connections: [conn("a", "idle"), conn("b", "idle"), conn("c", "idle")] }), {
    tone: "ok",
    text: "LLM · Fallback · 3\u00a0connections",
  });
  assert.deepEqual(summary({ mode: "single", connections: [conn("a", "idle")] }), {
    tone: "ok",
    text: "LLM · Box a · model-a",
  });
});

test("a busy pool names the connection translating, or how many are busy", () => {
  assert.equal(summary({ mode: "fallback", connections: [conn("a", "offline"), conn("b", "in_use", [7])] }).text, "Translating on Box b");
  assert.equal(
    summary({ mode: "parallel", connections: [conn("a", "in_use", [1]), conn("b", "in_use", [2]), conn("c", "idle")] }).text,
    "2 of 3 busy",
  );
});

test("the dot turns yellow when some connections are offline and red when all are", () => {
  assert.equal(summary({ mode: "fallback", connections: [conn("a", "in_use", [1]), conn("b", "offline")] }).tone, "warn");
  assert.equal(summary({ mode: "fallback", connections: [conn("a", "offline"), conn("b", "offline")] }).tone, "down");
  // An unchecked connection neither confirms nor contradicts the rest.
  assert.equal(summary({ mode: "fallback", connections: [conn("a", "idle"), conn("b", "unknown")] }).tone, "ok");
  assert.equal(summary({ mode: "single", connections: [conn("a", "unknown")] }).tone, "neutral");
});

test("offline connections are spelled out, so the state is not color alone", () => {
  const { detail } = summarizeLlmStatus({ mode: "fallback", connections: [conn("a", "idle"), conn("b", "offline")] }, false, t);
  assert.equal(detail, "1 offline");
  assert.equal(summarizeLlmStatus({ mode: "single", connections: [conn("a", "idle")] }, false, t).detail, "");
});

test("loading, failure, and an empty pool read as gray with their own text", () => {
  assert.deepEqual(summary(undefined), { tone: "neutral", text: "LLM · checking…" });
  assert.deepEqual(summary(undefined, true), { tone: "neutral", text: "LLM status unavailable" });
  assert.deepEqual(summary({ mode: "single", connections: [] }), { tone: "neutral", text: "LLM · not configured" });
});

test("a refetch error keeps showing the last known status", () => {
  assert.equal(summary({ mode: "single", connections: [conn("a", "idle")] }, true).text, "LLM · Box a · model-a");
});

test("each connection's state reads as a short phrase with its job ids", () => {
  assert.equal(connectionStateText(conn("a", "in_use", [12]), t), "in use · job #12");
  assert.equal(connectionStateText(conn("a", "in_use", [12, 15]), t), "in use · jobs #12, #15");
  assert.equal(connectionStateText(conn("a", "idle"), t), "idle");
  assert.equal(connectionStateText(conn("a", "offline"), t), "offline");
  assert.equal(connectionStateText(conn("a", "unknown"), t), "not checked");
});
