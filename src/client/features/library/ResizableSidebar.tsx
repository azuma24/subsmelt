import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import {
  SIDEBAR_MAX_WINDOW_SHARE,
  SIDEBAR_WIDTH,
  clampSidebarWidth,
  parseStoredWidth,
  widthAfterKey,
} from "./sidebar-width";

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

/** The Library's folder column. Drag its edge, or focus the edge and use the arrow keys; each browser keeps its own width. */
export function ResizableSidebar({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(readWidth);
  const [dragging, setDragging] = useState(false);
  const aside = useRef<HTMLElement>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const shownWidth = () => aside.current?.getBoundingClientRect().width ?? width;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: shownWidth() };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(clampSidebarWidth(drag.current.startWidth + event.clientX - drag.current.startX, window.innerWidth));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    writeWidth(width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = widthAfterKey(event.key, shownWidth(), window.innerWidth);
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
      <aside
        ref={aside}
        className="@container h-full overflow-y-auto border-r border-border p-2"
        style={{ width: `min(${width}px, ${SIDEBAR_MAX_WINDOW_SHARE * 100}vw)`, minWidth: SIDEBAR_WIDTH.min }}
      >
        {children}
      </aside>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t("library.folders.resize")}
        aria-valuemin={SIDEBAR_WIDTH.min}
        aria-valuemax={SIDEBAR_WIDTH.max}
        aria-valuenow={width}
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
