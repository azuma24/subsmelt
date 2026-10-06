import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Job } from "../../types";
import type { LibraryRow, LibrarySection } from "./library-model";
import { ItemRow, SectionHeader } from "./LibraryRows";

/** Below this many rows the list renders plainly; above it, only the visible window. */
export const VIRTUALIZE_THRESHOLD = 200;
const ROW_ESTIMATE_PX = 56;

const rowKey = (row: LibraryRow): string =>
  row.type === "section" ? `section:${row.section.key}` : `item:${row.entry.item.key}`;

const NEXT_KEYS = new Set(["ArrowDown", "j"]);
const PREV_KEYS = new Set(["ArrowUp", "k"]);

/** Ask the list to focus a row, scrolling it into the window first. A new object re-asks. */
export interface FocusRequest {
  key: string;
}

interface LibraryListProps {
  rows: LibraryRow[];
  jobsById: Map<number, Job>;
  checked: ReadonlySet<string>;
  openKey: string | null;
  /** The row that takes Tab focus: the open one, else the first. */
  focusKey: string | null;
  focusRequest: FocusRequest | null;
  onToggleChecked: (key: string) => void;
  onToggleSection: (section: LibrarySection) => void;
  onToggleCollapsed: (key: string) => void;
  onOpen: (key: string) => void;
}

export function LibraryList(props: LibraryListProps) {
  const {
    rows,
    jobsById,
    checked,
    openKey,
    focusKey,
    focusRequest,
    onToggleChecked,
    onToggleSection,
    onToggleCollapsed,
    onOpen,
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = rows.length >= VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => rowKey(rows[index]),
    overscan: 12,
  });
  const itemRowIndexes = useMemo(() => rows.flatMap((row, index) => (row.type === "item" ? [index] : [])), [rows]);

  // Roving tabindex: one row takes Tab. When virtualized and that row is out of
  // the rendered window, the first rendered row stands in so Tab still reaches the list.
  const virtualItems = virtualize ? virtualizer.getVirtualItems() : [];
  const renderedKeys = virtualize
    ? virtualItems.flatMap((v) => {
        const row = rows[v.index];
        return row?.type === "item" ? [row.entry.item.key] : [];
      })
    : null;
  const tabKey =
    renderedKeys && focusKey !== null && !renderedKeys.includes(focusKey) ? (renderedKeys[0] ?? null) : focusKey;

  const renderRow = (row: LibraryRow): ReactNode => {
    if (row.type === "section") {
      const checkedCount = row.section.items.filter((entry) => checked.has(entry.item.key)).length;
      return (
        <SectionHeader
          section={row.section}
          collapsed={row.collapsed}
          checkedCount={checkedCount}
          onToggleCollapsed={onToggleCollapsed}
          onToggleChecked={onToggleSection}
        />
      );
    }
    const key = row.entry.item.key;
    return (
      <ItemRow
        entry={row.entry}
        mode={row.mode}
        jobsById={jobsById}
        checked={checked.has(key)}
        open={openKey === key}
        focusable={tabKey === key}
        onToggleChecked={onToggleChecked}
        onOpen={onOpen}
      />
    );
  };

  const focusRow = (rowIndex: number) => {
    const row = rows[rowIndex];
    if (row?.type !== "item") return;
    const find = () =>
      scrollRef.current?.querySelector<HTMLButtonElement>(`[data-row-key="${CSS.escape(row.entry.item.key)}"]`);
    const element = find();
    if (element) {
      element.focus();
      return;
    }
    virtualizer.scrollToIndex(rowIndex, { align: "auto" });
    requestAnimationFrame(() => find()?.focus());
  };

  useEffect(() => {
    if (!focusRequest) return;
    const index = rows.findIndex((row) => row.type === "item" && row.entry.item.key === focusRequest.key);
    if (index >= 0) focusRow(index);
    // Only a new request should move focus, not every rows update.
  }, [focusRequest]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = (event.target as HTMLElement).dataset.rowKey;
    if (!key || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = NEXT_KEYS.has(event.key) ? 1 : PREV_KEYS.has(event.key) ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const current = itemRowIndexes.findIndex((index) => {
      const row = rows[index];
      return row.type === "item" && row.entry.item.key === key;
    });
    const next = itemRowIndexes[Math.min(itemRowIndexes.length - 1, Math.max(0, current + step))];
    if (next !== undefined) focusRow(next);
  };

  return (
    <div ref={scrollRef} onKeyDown={handleKeyDown} className="min-h-0 flex-1 overflow-y-auto">
      {virtualize ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualRow) => (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderRow(rows[virtualRow.index])}
            </div>
          ))}
        </div>
      ) : (
        rows.map((row) => <div key={rowKey(row)}>{renderRow(row)}</div>)
      )}
    </div>
  );
}
