import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { I18n, TFunction } from "./core";

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ i18n, children }: { i18n: I18n; children: ReactNode }) {
  return <I18nContext.Provider value={i18n}>{children}</I18nContext.Provider>;
}

/**
 * The current language's `t`, re-rendering the component when the language
 * changes or a bundle arrives (the other languages load after first paint).
 */
export function useTranslation(): { t: TFunction; i18n: I18n } {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error("useTranslation needs an I18nProvider above it");
  const subscribe = useCallback(
    (onChange: () => void) => {
      const offLanguage = i18n.on("languageChanged", onChange);
      const offLoaded = i18n.on("loaded", onChange);
      return () => {
        offLanguage();
        offLoaded();
      };
    },
    [i18n],
  );
  // The snapshot only has to change when a render is due; the language plus a
  // bundle count does that without allocating on every read.
  const snapshot = useSyncExternalStore(
    subscribe,
    () => `${i18n.language}:${i18n.hasBundle(i18n.language) ? 1 : 0}`,
    () => `${i18n.language}:${i18n.hasBundle(i18n.language) ? 1 : 0}`,
  );
  void snapshot;
  return { t: i18n.t, i18n };
}
