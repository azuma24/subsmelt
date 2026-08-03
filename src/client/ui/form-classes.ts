/**
 * Shared Tailwind class strings for form controls.
 *
 * SettingsPage and ConnectionsPanel each carried a byte-identical copy of this,
 * which is how two inputs drift apart one tweak at a time. WhisperPage's compact
 * selects are deliberately a different size and stay local to that page.
 */
export const FORM_CONTROL_CLS =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]";

export const FORM_LABEL_CLS = "mb-1.5 block text-[12px] font-medium text-[var(--text-2)]";
