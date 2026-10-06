// Light/dark theme handling. The user preference ("system" | "dark" | "light")
// is stored client-side in localStorage; the *resolved* theme ("dark" | "light")
// is written to <html data-theme="..."> which the CSS variables in index.css key
// off. A matching bootstrap script in index.html applies this before React mounts
// to avoid a flash of the wrong theme.

export type ThemePref = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export const THEME_KEY = "subsmelt-theme";
export const THEME_PREFS: ThemePref[] = ["system", "dark", "light"];

export function getThemePref(): ThemePref {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value && (THEME_PREFS as string[]).includes(value)) return value as ThemePref;
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return "system";
}

export function systemTheme(): ResolvedTheme {
  try {
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches) {
      return "light";
    }
  } catch {
    /* ignore */
  }
  return "dark";
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

export function applyTheme(pref: ThemePref): void {
  try {
    document.documentElement.setAttribute("data-theme", resolveTheme(pref));
  } catch {
    /* ignore */
  }
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
}

/** Re-apply the theme when the OS scheme changes, but only while on "system". */
export function watchSystemTheme(onChange: () => void): () => void {
  try {
    const mq = matchMedia("(prefers-color-scheme: light)");
    const handler = (): void => onChange();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  } catch {
    return () => {};
  }
}
