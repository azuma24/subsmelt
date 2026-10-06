import type { TFunction } from "i18next";
import type { LlmConnectionStatus, LlmMode, LlmStatus } from "../types";

/** ok = all reachable, warn = some offline, down = none reachable, neutral = nothing known. */
export type LlmTone = "ok" | "warn" | "down" | "neutral";

export interface LlmSummary {
  tone: LlmTone;
  /** The short status line. */
  text: string;
  /** Offline count for screen readers and the tooltip; "" when none. */
  detail: string;
}

const MODE_KEY: Record<LlmMode, string> = {
  single: "settings.connections.modeSingle",
  fallback: "settings.connections.modeFallback",
  parallel: "settings.connections.modeParallel",
};

export const TONE_DOT_CLASS: Record<LlmTone, string> = {
  ok: "bg-[var(--green)]",
  warn: "bg-[var(--yellow)]",
  down: "bg-[var(--red)]",
  neutral: "bg-[var(--text-3)]",
};

export function modeLabel(mode: LlmMode, t: TFunction): string {
  return t(MODE_KEY[mode] ?? MODE_KEY.single);
}

function toneOf(connections: LlmConnectionStatus[]): LlmTone {
  // Unchecked connections say nothing either way, so only the known ones count.
  const known = connections.filter((conn) => conn.state !== "unknown");
  const offline = known.filter((conn) => conn.state === "offline").length;
  if (known.length === 0) return "neutral";
  if (offline === 0) return "ok";
  return offline === known.length ? "down" : "warn";
}

function lineOf(status: LlmStatus, t: TFunction): string {
  const { connections } = status;
  const busy = connections.filter((conn) => conn.state === "in_use");
  if (busy.length === 1) return t("llmStatus.translatingOn", { label: busy[0].label });
  if (busy.length > 1) return t("llmStatus.busyOf", { busy: busy.length, total: connections.length });
  if (connections.length === 1) {
    return t("llmStatus.idleOne", { label: connections[0].label, model: connections[0].model });
  }
  return t("llmStatus.idleMany", { mode: modeLabel(status.mode, t), count: connections.length });
}

/**
 * The sidebar line for GET /api/llm/status. `failed` only matters before the
 * first answer: a failed refetch keeps showing the last status it had.
 */
export function summarizeLlmStatus(status: LlmStatus | undefined, failed: boolean, t: TFunction): LlmSummary {
  if (!status) {
    return { tone: "neutral", text: t(failed ? "llmStatus.loadFailed" : "llmStatus.checking"), detail: "" };
  }
  if (status.connections.length === 0) {
    return { tone: "neutral", text: t("llmStatus.notConfigured"), detail: "" };
  }
  const offline = status.connections.filter((conn) => conn.state === "offline").length;
  return {
    tone: toneOf(status.connections),
    text: lineOf(status, t),
    detail: offline > 0 ? t("llmStatus.offlineCount", { count: offline }) : "",
  };
}

/** One popover row's state: "in use · job #12", "idle", "offline". */
export function connectionStateText(conn: LlmConnectionStatus, t: TFunction): string {
  switch (conn.state) {
    case "in_use":
      return conn.jobIds.length === 1
        ? t("llmStatus.inUseJob", { job: conn.jobIds[0] })
        : t("llmStatus.inUseJobs", { jobs: conn.jobIds.map((id) => `#${id}`).join(", ") });
    case "idle":
      return t("llmStatus.idle");
    case "offline":
      return t("llmStatus.offline");
    default:
      return t("llmStatus.unknown");
  }
}
