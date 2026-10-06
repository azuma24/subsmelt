import { FORM_CONTROL_CLS, FORM_LABEL_CLS } from "../../../ui/form-classes";

/**
 * Class strings and the one-off row widget shared by the extracted Settings
 * sections. These were file-local consts in `SettingsPage.tsx` before the
 * sections moved out; the strings are byte-identical to what that file used.
 */
export const selectCls = FORM_CONTROL_CLS;
export const textareaCls = FORM_CONTROL_CLS;
export const labelCls = FORM_LABEL_CLS;

/** Coerce a settings value to boolean — `settings` is a Record<string, unknown> on the wire. */
export const bool = (v: unknown): boolean => Boolean(v);

export function ToggleRow({ title, description, checked, onChange }: { title: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm border border-border bg-surface-raised px-3 py-3">
      <div>
        <p className="text-sm font-medium text-text">{title}</p>
        {description && <p className="mt-1 text-xs text-muted">{description}</p>}
      </div>
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-accent"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
