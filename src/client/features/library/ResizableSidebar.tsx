import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { SIDEBAR_WIDTH, clampSidebarWidth, parseStoredWidth, sidebarMaxWidth, widthAfterKey } from "./sidebar-width";

const WIDTH_KEY = "subsmelt.library.folders.width";

function readWidth(): number {
  try {
    return parseStoredWidth(localStorage.getItem(WIDTH_KEY));
  } catch {
    return SIDEBAR_WIDTH.default;
  }
}

function writeWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Private mode or storage off: the width lasts for this page only.
  }
}

function readWindowWidth(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

/** The Library's folder column. Drag its edge, or focus the edge and use the arrow keys; each browser keeps its own width. */
export function ResizableSidebar({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(readWidth);
  const [windowWidth, setWindowWidth] = useState(readWindowWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  // The saved width is kept as chosen, so it comes back when the window grows again.
  const shown = clampSidebarWidth(width, windowWidth);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: shown };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(clampSidebarWidth(drag.current.startWidth + event.clientX - drag.current.startX, windowWidth));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    writeWidth(shown);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = widthAfterKey(event.key, shown, windowWidth);
    if (next === null) return;
    event.preventDefault();
    setWidth(next);
    writeWidth(next);
  };
  const reset = () => {
    setWidth(SIDEBAR_WIDTH.default);
    writeWidth(SIDEBAR_WIDTH.default);
  };

  return (
    <div className="relative hidden shrink-0 md:block">
      <aside className="@container h-full overflow-y-auto border-r border-border p-2" style={{ width: shown }}>
        {children}
      </aside>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t("library.folders.resize")}
        aria-valuemin={SIDEBAR_WIDTH.min}
        aria-valuemax={sidebarMaxWidth(windowWidth)}
        aria-valuenow={shown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={reset}
        className="group/resize absolute inset-y-0 -right-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center focus-visible:outline-none"
      >
        <span
          className={`h-full w-0.5 transition-colors group-hover/resize:bg-accent group-focus-visible/resize:bg-accent ${dragging ? "bg-accent" : "bg-transparent"}`}
        />
      </div>
    </div>
  );
}
