import { createContext, useContext, useEffect, useState } from "react";

/**
 * Whether the viewport is a phone (below the md breakpoint). App measures it
 * once and provides it; every component reads it with useIsMobile, so no
 * page has to pass it down and tests can render the phone layout directly.
 */
export const IsMobileContext = createContext(false);

export function useIsMobile(): boolean {
  return useContext(IsMobileContext);
}

/** The live media query; App feeds its value into IsMobileContext. */
export function useViewportIsMobile(): boolean {
  // Guard for non-DOM environments (SSR/tests); the initializer already
  // captures the current match, so the effect only needs the change listener.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isMobile;
}
