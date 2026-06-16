import { getSetting } from "./config.js";
import { logger } from "./logger.js";

// Outbound webhook notifications. Additive + disabled by default (empty
// notify_webhook_url). A webhook failure must NEVER affect translation or the
// queue — every path here is wrapped in try/catch and only logs on failure.

const REQUEST_TIMEOUT_MS = 8000;

type NotifyFormat = "json" | "discord" | "slack";

function parseEvents(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
  );
}

function formatDuration(seconds: unknown): string {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(n)) return "?";
  return n >= 60 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${n.toFixed(1)}s`;
}

// Build a human-readable one-line summary for an event. Used as the body for
// discord/slack formats and is convenient context for json consumers too.
function humanString(event: string, payload: Record<string, unknown>): string {
  const srtName = typeof payload.srtName === "string" ? payload.srtName : "subtitle";
  const langCode = typeof payload.langCode === "string" ? payload.langCode : "";
  switch (event) {
    case "job:done":
      return `✅ Translated ${srtName}${langCode ? ` → ${langCode}` : ""} in ${formatDuration(payload.durationSeconds)}`;
    case "job:error": {
      const error = typeof payload.error === "string" ? payload.error : "unknown error";
      return `❌ Translation failed: ${srtName} — ${error}`;
    }
    case "queue:finished":
      return "🏁 Queue finished — all pending translations complete";
    case "queue:stopped":
      return "⏹️ Queue stopped by user request";
    case "test":
      return typeof payload.message === "string" ? payload.message : "🔔 SubSmelt test notification";
    default:
      return `SubSmelt event: ${event}`;
  }
}

function buildBody(format: NotifyFormat, event: string, payload: Record<string, unknown>): unknown {
  const human = humanString(event, payload);
  if (format === "discord") return { content: human };
  if (format === "slack") return { text: human };
  // json (default): structured envelope with a timestamp.
  return { event, ...payload, message: human, timestamp: new Date().toISOString() };
}

// POST the formatted body to the webhook. Throws on transport/HTTP failure so
// callers that care (the test endpoint) can surface the reason.
async function postWebhook(webhookUrl: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const rawFormat = getSetting("notify_format").trim().toLowerCase();
  const format: NotifyFormat = rawFormat === "discord" || rawFormat === "slack" ? rawFormat : "json";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(format, event, payload)),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fire an outbound webhook for an event, if configured. No-op when there is no
 * webhook URL or the event is not in notify_events. Never throws.
 */
export async function notify(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const webhookUrl = getSetting("notify_webhook_url").trim();
    if (!webhookUrl) return;

    const events = parseEvents(getSetting("notify_events"));
    if (!events.has(event)) return;

    await postWebhook(webhookUrl, event, payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("system", `Notification webhook failed for ${event}: ${message}`);
  }
}

/**
 * Send a sample notification using the currently-configured webhook + format,
 * bypassing the notify_events filter so the UI can verify connectivity even
 * when only error events are enabled. Returns a result instead of throwing.
 */
export async function notifyTest(): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = getSetting("notify_webhook_url").trim();
  if (!webhookUrl) {
    return { ok: false, error: "No webhook URL configured" };
  }
  try {
    await postWebhook(webhookUrl, "test", {
      message: "🔔 SubSmelt test notification — your webhook is working!",
    });
    logger.info("system", "Notification webhook test sent successfully");
    return { ok: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("system", `Notification webhook test failed: ${message}`);
    return { ok: false, error: message };
  }
}
