import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { JobRow } from "../types";
import { STATUS_ICON, STATUS_LABEL_KEY } from "../app/constants";

export function StatusPill({ label, tone, truncate = false }: { label: string; tone: "green" | "emerald" | "blue" | "gray"; truncate?: boolean }) {
  const cls = {
    green: "bg-green-900/30 text-green-300 border-green-800/50",
    emerald: "bg-emerald-900/30 text-emerald-300 border-emerald-800/50",
    blue: "bg-blue-900/30 text-blue-300 border-blue-800/50",
    gray: "bg-gray-900 text-gray-400 border-gray-800",
  }[tone];
  return <div className={`rounded-full border px-3 py-1.5 leading-5 ${cls} ${truncate ? "max-w-[220px] truncate" : ""}`}>{label}</div>;
}

interface ActionButtonProps {
  children: ReactNode;
  onClick: () => void;
  variant?: "primary" | "success" | "danger" | "ghost" | "warning";
  disabled?: boolean;
  busy?: boolean;
}

export function ActionButton({ children, onClick, variant = "primary", disabled = false, busy = false }: ActionButtonProps) {
  const cls = {
    primary: "bg-blue-600 hover:bg-blue-700 text-white",
    success: "bg-green-600 hover:bg-green-700 text-white",
    danger: "bg-red-600 hover:bg-red-700 text-white",
    ghost: "bg-gray-800 hover:bg-gray-700 text-gray-200",
    warning: "bg-yellow-700 hover:bg-yellow-600 text-yellow-100",
  }[variant];
  return <button onClick={onClick} disabled={disabled || busy} className={`min-h-[44px] rounded-2xl px-4 py-3 text-sm font-medium leading-6 transition-colors disabled:opacity-50 ${cls}`}>{children}</button>;
}

export function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return <div className="rounded-3xl border border-gray-800 bg-gray-900/80 p-4"><div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div><div className="mt-1 text-sm text-gray-400">{label}</div></div>;
}

export function StatusBadge({ job, compact = false }: { job: JobRow; compact?: boolean }) {
  const { t } = useTranslation();
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 ${compact ? "text-xs" : "text-sm"} font-medium leading-5 ${job.status === "done" ? "bg-green-900/20 text-green-400" : job.status === "translating" ? "bg-blue-900/20 text-blue-400" : job.status === "error" ? "bg-red-900/20 text-red-400" : job.status === "skipped" ? "bg-gray-800/50 text-gray-400" : "bg-yellow-900/20 text-yellow-400"}`}>{STATUS_ICON[job.status]} {STATUS_LABEL_KEY[job.status] ? t(STATUS_LABEL_KEY[job.status]) : job.status}{job.force ? " ⚡" : ""}{job.priority > 0 ? " 📌" : ""}</span>;
}

export function ProgressSmall({ pct, large = false }: { pct: number; large?: boolean }) {
  const boundedPct = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex items-center gap-2">
      <div
        className={`rounded-full bg-gray-800 ${large ? "h-3" : "h-1.5"} flex-1`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={boundedPct}
        aria-label={`${boundedPct}%`}
      >
        <div className={`rounded-full bg-blue-500 ${large ? "h-3" : "h-1.5"}`} style={{ width: `${boundedPct}%` }} />
      </div>
      <span className="text-xs text-gray-400">{boundedPct}%</span>
    </div>
  );
}

export function MiniBtn({ children, onClick, color = "default" }: { children: ReactNode; onClick: () => void; color?: string }) {
  const cls = color === "yellow" ? "bg-yellow-800/60 hover:bg-yellow-700/60 text-yellow-200" : "bg-gray-800 hover:bg-gray-700 text-gray-300";
  return <button onClick={onClick} className={`min-h-[36px] rounded-lg px-2.5 py-1.5 text-xs leading-5 ${cls}`}>{children}</button>;
}

export function Field({ label, value, onChange, placeholder, help, error, type = "text", required }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; help?: string; error?: string; type?: string; required?: boolean }) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? errorId : help ? helpId : undefined;

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-gray-300">
        {label} {required && <span className="text-red-400">*</span>}
      </label>
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        required={required}
        className={`w-full rounded-2xl border px-3 py-3 text-base leading-6 text-gray-100 md:text-sm ${error ? "border-red-600 bg-gray-800" : "border-gray-700 bg-gray-800"}`}
      />
      {error && <p id={errorId} className="mt-1 text-xs leading-5 text-red-300">{error}</p>}
      {help && !error && <p id={helpId} className="mt-1 text-xs leading-5 text-gray-400">{help}</p>}
    </div>
  );
}

export function EmptyHint({ text, subtext }: { text: string; subtext?: string }) {
  return <div className="rounded-3xl border border-dashed border-gray-800 bg-gray-900/30 px-4 py-12 text-center text-sm leading-6 text-gray-400"><p>{text}</p>{subtext && <p className="mt-2 text-xs leading-5 text-gray-500">{subtext}</p>}</div>;
}

export function DetailCard({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4"><div className="text-xs text-gray-400">{label}</div><div className={`mt-1 break-all text-sm leading-6 text-gray-100 ${mono ? "font-mono" : ""}`}>{value}</div></div>;
}

export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="space-y-5 rounded-3xl border border-gray-800 bg-gray-900/80 p-5 md:p-6"><div><h2 className="text-base font-semibold text-gray-100">{title}</h2>{description && <p className="mt-1 text-sm leading-6 text-gray-400">{description}</p>}</div>{children}</section>;
}
