import { useId, type ReactNode } from "react";

/** The one control style for inputs, selects and textareas; Field, Select and TextArea apply it. */
export const CONTROL_CLS =
  "w-full rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm leading-6 text-text transition-colors focus:border-accent min-h-touch md:min-h-0";
export const LABEL_CLS = "mb-2 block text-xs font-medium text-muted";
const HELP_CLS = "mt-1 text-xs leading-6 text-faint";

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  help?: string;
  error?: string;
  type?: string;
  required?: boolean;
  /** Shown but not editable, e.g. a setting an environment variable provides. */
  readOnly?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
}

export function Field({ label, value, onChange, placeholder, help, error, type = "text", required, readOnly = false, min, max, step }: FieldProps) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? errorId : help ? helpId : undefined;

  return (
    <div>
      <label htmlFor={inputId} className="mb-2 block text-xs font-medium text-muted">
        {label} {required && <span className="text-danger">*</span>}
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
        readOnly={readOnly}
        min={min}
        max={max}
        step={step}
        className={`w-full rounded-sm border bg-surface-raised px-3 py-2 text-sm leading-6 transition-colors focus:border-accent min-h-touch md:min-h-0 ${readOnly ? "cursor-not-allowed text-muted" : "text-text"} ${error ? "border-danger-line" : "border-border"}`}
      />
      {error && <p id={errorId} className="mt-1 text-xs leading-6 text-danger">{error}</p>}
      {help && !error && <p id={helpId} className="mt-1 text-xs leading-6 text-faint">{help}</p>}
    </div>
  );
}

interface SelectProps {
  /** The visible label. Without one, pass ariaLabel. */
  label?: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  /** The option elements. */
  children: ReactNode;
  help?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Select({ label, ariaLabel, value, onChange, children, help, disabled = false, id, className = "" }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const helpId = `${selectId}-help`;
  const control = (
    <select
      id={selectId}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={help ? helpId : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className={`${CONTROL_CLS} disabled:cursor-not-allowed disabled:text-muted ${className}`}
    >
      {children}
    </select>
  );
  if (!label && !help) return control;
  return (
    <div>
      {label && <label htmlFor={selectId} className={LABEL_CLS}>{label}</label>}
      {control}
      {help && <p id={helpId} className={HELP_CLS}>{help}</p>}
    </div>
  );
}

interface TextAreaProps {
  label?: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  help?: string;
  /** Code, prompts and JSON read better in the monospace face. */
  mono?: boolean;
  readOnly?: boolean;
  className?: string;
}

export function TextArea({ label, ariaLabel, value, onChange, rows = 4, placeholder, help, mono = false, readOnly = false, className = "" }: TextAreaProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const control = (
    <textarea
      id={id}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={help ? helpId : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      rows={rows}
      placeholder={placeholder}
      readOnly={readOnly}
      className={`${CONTROL_CLS} ${mono ? "font-mono text-xs leading-relaxed" : ""} ${readOnly ? "cursor-not-allowed text-muted" : ""} ${className}`}
    />
  );
  if (!label && !help) return control;
  return (
    <div>
      {label && <label htmlFor={id} className={LABEL_CLS}>{label}</label>}
      {control}
      {help && <p id={helpId} className={HELP_CLS}>{help}</p>}
    </div>
  );
}

interface CheckboxProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  disabled?: boolean;
  className?: string;
}

/** A labelled checkbox; the whole label is the hit target. */
export function Checkbox({ label, checked, onChange, description, disabled = false, className = "" }: CheckboxProps) {
  return (
    <label className={`flex items-start gap-2 text-sm text-text ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block leading-6">{label}</span>
        {description && <span className="block text-xs leading-5 text-muted">{description}</span>}
      </span>
    </label>
  );
}
