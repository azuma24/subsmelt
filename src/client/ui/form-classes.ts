/**
 * Shared Tailwind class strings for form controls.
 *
 * SettingsPage and ConnectionsPanel each carried a byte-identical copy of this,
 * which is how two inputs drift apart one tweak at a time. WhisperPage's compact
 * selects are deliberately a different size and stay local to that page.
 */
export const FORM_CONTROL_CLS =
  "w-full rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm text-text focus:border-accent min-h-touch md:min-h-0";

export const FORM_LABEL_CLS = "mb-2 block text-xs font-medium text-muted";
