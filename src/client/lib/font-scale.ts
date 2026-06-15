// UI font scale. The user preference (a percentage, e.g. 100) is stored
// client-side in localStorage and applied as a root CSS `zoom` factor. The UI
// uses fixed-px sizing throughout, so root `font-size` would not scale it —
// `zoom` scales the whole interface uniformly. A matching bootstrap script in
// index.html applies this before React mounts to avoid a flash of the wrong size.

export const FONT_SCALE_KEY = "subsmelt-font-scale";
export const MIN_SCALE = 70;
export const MAX_SCALE = 150;
export const SCALE_STEP = 10;
export const DEFAULT_SCALE = 100;

export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCALE;
  const stepped = Math.round(value / SCALE_STEP) * SCALE_STEP;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, stepped));
}

export function getFontScale(): number {
  try {
    const raw = localStorage.getItem(FONT_SCALE_KEY);
    if (raw !== null) return clampScale(parseInt(raw, 10));
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return DEFAULT_SCALE;
}

export function applyFontScale(scale: number): void {
  try {
    // `zoom` is non-standard but supported across Chromium/WebKit; it scales the
    // entire fixed-px UI. Typed loosely because CSSStyleDeclaration omits `zoom`.
    (document.documentElement.style as unknown as { zoom: string }).zoom =
      String(clampScale(scale) / 100);
  } catch {
    /* ignore */
  }
}

export function setFontScale(scale: number): number {
  const next = clampScale(scale);
  try {
    localStorage.setItem(FONT_SCALE_KEY, String(next));
  } catch {
    /* ignore */
  }
  applyFontScale(next);
  return next;
}
