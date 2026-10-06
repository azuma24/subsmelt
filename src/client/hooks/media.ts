import { useEffect, useState } from "react";

export function useIsMobile() {
  // Guard for non-DOM environments (e.g. SSR/tests); the initializer already
  // captures the current match, so the effect only needs the change listener.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
  );

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // No redundant setIsMobile(mql.matches) here — the useState initializer
    // already captured the initial value, so re-setting it forced an extra
    // render on every mount.
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isMobile;
}
