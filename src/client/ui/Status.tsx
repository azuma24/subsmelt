import { Icon, type IconName } from "./Icon";

export type StatusTone = "ok" | "run" | "bad" | "warn" | "neutral";

/** What a status badge shows: every status carries a glyph and text, never color alone.
 *  The glyph is either a text character or a named icon. */
export interface StatusDescriptor {
  glyph: string | { icon: IconName };
  label: string;
  tone: StatusTone;
  /** Markers after the label (forced, pinned); each carries its own accessible name. */
  flags?: readonly StatusFlag[];
}

export interface StatusFlag {
  icon: IconName;
  label: string;
}

const STATUS_TONE_CLS: Record<StatusTone, string> = {
  ok: "bg-success-soft text-success border border-success-line",
  run: "bg-accent-soft text-accent border border-accent-line",
  bad: "bg-danger-soft text-danger border border-danger-line",
  warn: "bg-warning-soft text-warning border border-dashed border-warning-line",
  neutral: "bg-surface-raised text-muted border border-border",
};

export function StatusBadge({ status }: { status: StatusDescriptor }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium leading-6 ${STATUS_TONE_CLS[status.tone]}`}>
      {typeof status.glyph === "string" ? <span aria-hidden="true">{status.glyph}</span> : <Icon name={status.glyph.icon} />} {status.label}
      {status.flags?.map((flag) => <Icon key={flag.icon} name={flag.icon} label={flag.label} />)}
    </span>
  );
}

export function ProgressSmall({ pct, large = false }: { pct: number; large?: boolean }) {
  const boundedPct = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex items-center gap-2">
      <div
        className={`overflow-hidden rounded-full bg-surface-highlight ${large ? "h-2" : "h-1"} flex-1`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={boundedPct}
        aria-label={`${boundedPct}%`}
      >
        <div className={`rounded-full bg-accent ${large ? "h-2" : "h-1"}`} style={{ width: `${boundedPct}%` }} />
      </div>
      <span className="font-mono text-xs text-muted">{boundedPct}%</span>
    </div>
  );
}
