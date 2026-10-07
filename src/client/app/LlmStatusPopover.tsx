import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../i18n";
import type { TFunction } from "../i18n";
import { useLlmStatusQuery } from "../hooks";
import type { LlmConnectionStatus, LlmStatus } from "../types";
import { connectionStateText, modeLabel, summarizeLlmStatus, TONE_DOT_CLASS } from "./llm-status-summary";

const PANEL_WIDTH = 320;
// Under a phone header the panel spans the screen, up to this width.
const PANEL_WIDTH_BELOW = 400;
const VIEWPORT_GUTTER = 16;
const ANCHOR_GAP = 8;

type Placement = "side" | "below";

interface Position {
  top: number;
  left: number;
  width: number;
}

/** Beside the trigger (sidebar, either text direction), or under it (phone header). */
function placePanel(anchor: DOMRect, height: number, placement: Placement): Position {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(placement === "side" ? PANEL_WIDTH : PANEL_WIDTH_BELOW, vw - VIEWPORT_GUTTER * 2);
  const clampTop = (top: number) => Math.max(VIEWPORT_GUTTER, Math.min(top, vh - height - VIEWPORT_GUTTER));
  const clampLeft = (left: number) => Math.max(VIEWPORT_GUTTER, Math.min(left, vw - width - VIEWPORT_GUTTER));
  if (placement === "side") {
    const fitsRight = anchor.right + ANCHOR_GAP + width <= vw - VIEWPORT_GUTTER;
    const left = fitsRight ? anchor.right + ANCHOR_GAP : anchor.left - ANCHOR_GAP - width;
    // Bottom-aligned with the trigger: it sits low in the sidebar.
    return { top: clampTop(anchor.bottom - height), left: clampLeft(left), width };
  }
  return { top: clampTop(anchor.bottom + ANCHOR_GAP / 2), left: clampLeft(anchor.left), width };
}

const STATE_TEXT_CLASS: Record<LlmConnectionStatus["state"], string> = {
  in_use: "text-success",
  idle: "text-muted",
  offline: "text-danger",
  unknown: "text-faint",
};

const STATE_DOT_CLASS: Record<LlmConnectionStatus["state"], string> = {
  in_use: "bg-success",
  idle: "bg-success",
  offline: "bg-danger",
  unknown: "bg-faint",
};

function ConnectionRow({ conn, index, t }: { conn: LlmConnectionStatus; index: number; t: TFunction }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2">
      <span
        aria-hidden="true"
        className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-raised font-mono text-xs text-muted"
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-text" title={conn.label}>
            {conn.label}
          </span>
          <span className={`flex shrink-0 items-center gap-1 text-xs ${STATE_TEXT_CLASS[conn.state]}`}>
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATE_DOT_CLASS[conn.state]}`} />
            {connectionStateText(conn, t)}
          </span>
        </div>
        <div className="truncate font-mono text-xs text-muted" title={conn.model}>
          {conn.model}
        </div>
        <div className="truncate font-mono text-xs text-faint" title={conn.host}>
          {conn.host}
        </div>
      </div>
    </li>
  );
}

function SkeletonRows() {
  return (
    <ul aria-hidden="true" className="py-2">
      {[0, 1].map((row) => (
        <li key={row} className="flex items-start gap-3 px-4 py-2">
          <span className="h-5 w-5 shrink-0 rounded-full bg-surface-raised" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-2/3 rounded-sm bg-surface-raised" />
            <div className="h-3 w-1/2 rounded-sm bg-surface-raised" />
          </div>
        </li>
      ))}
    </ul>
  );
}

interface PanelBodyProps {
  status: LlmStatus | undefined;
  failed: boolean;
  onRetry: () => void;
  t: TFunction;
}

function PanelBody({ status, failed, onRetry, t }: PanelBodyProps) {
  if (!status && failed) {
    return (
      <div className="space-y-2 px-4 py-3 text-sm text-muted">
        <p>{t("llmStatus.errorHint")}</p>
        <button
          type="button"
          onClick={onRetry}
          className="min-h-touch rounded-sm border border-border px-3 text-sm text-text hover:bg-surface-raised md:min-h-0 md:py-1"
        >
          {t("errors.retry")}
        </button>
      </div>
    );
  }
  if (!status) return <SkeletonRows />;
  if (status.connections.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted">{t("llmStatus.emptyHint")}</p>;
  }
  return (
    <ol className="max-h-[50vh] overflow-y-auto py-2">
      {status.connections.map((conn, index) => (
        <ConnectionRow key={conn.id} conn={conn} index={index} t={t} />
      ))}
    </ol>
  );
}

interface LlmStatusPopoverProps {
  /** "side" opens beside a sidebar trigger; "below" under a header trigger. */
  placement: Placement;
  /** Hide the text below `lg`, where the sidebar is a compact icon rail. */
  compactBelowLg?: boolean;
}

/**
 * The LLM status line and its connection list. A disclosure, not a menu: the
 * panel follows the button in the DOM, so Tab walks straight into it.
 */
export function LlmStatusPopover({ placement, compactBelowLg = false }: LlmStatusPopoverProps) {
  const { t } = useTranslation();
  const query = useLlmStatusQuery();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  const status = query.data;
  const summary = summarizeLlmStatus(status, query.isError, t);
  const tooltip = summary.detail ? `${summary.text} · ${summary.detail}` : summary.text;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel is re-placed when its content (status, error) changes height
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      if (!buttonRef.current || !panelRef.current) return;
      setPos(placePanel(buttonRef.current.getBoundingClientRect(), panelRef.current.offsetHeight, placement));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, placement, status, query.isError]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // The sidebar wraps to a second line rather than cutting "3 connections" short.
  const textClass = compactBelowLg ? "sr-only break-words lg:not-sr-only lg:line-clamp-2" : "truncate";

  return (
    <div ref={wrapperRef} className="min-w-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={tooltip}
        className={`flex min-h-touch w-full min-w-0 ${compactBelowLg ? "items-start" : "items-center"} gap-2 rounded-sm px-1 text-left text-xs text-muted transition-colors hover:bg-surface-raised hover:text-text md:min-h-0 md:py-1`}
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${compactBelowLg ? "mt-1" : ""} ${TONE_DOT_CLASS[summary.tone]}`}
        />
        <span className={textClass}>{summary.text}</span>
        {summary.detail && <span className="sr-only">{summary.detail}</span>}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: "hidden", top: 0, left: 0 }}
          className="fixed z-50 overflow-hidden rounded-md border border-border bg-surface shadow-2"
        >
          <div className="border-b border-border-subtle px-4 py-3">
            <h2 id={titleId} className="text-sm font-semibold text-text">
              {t("llmStatus.title")}
            </h2>
            {status && status.connections.length > 0 && (
              <p className="text-xs text-muted">{t("llmStatus.modeLine", { mode: modeLabel(status.mode, t) })}</p>
            )}
          </div>
          <PanelBody status={status} failed={query.isError} onRetry={() => void query.refetch()} t={t} />
          <div className="border-t border-border-subtle px-2 py-1">
            <Link
              to="/settings?section=llm"
              onClick={() => setOpen(false)}
              className="flex min-h-touch items-center rounded-sm px-2 text-sm font-medium text-accent hover:bg-surface-raised md:min-h-0 md:py-2"
            >
              {t("llmStatus.manage")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
