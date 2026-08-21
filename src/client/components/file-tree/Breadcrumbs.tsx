import { breadcrumbItems, truncateBreadcrumb, ELLIPSIS } from "./breadcrumb";

const DEFAULT_MAX_ITEMS = 4;

interface BreadcrumbsProps {
  path: string;
  homeLabel: string;
  onJump: (path: string) => void;
  maxItems?: number;
}

/** Drill-down breadcrumb bar: Home / … / parent / current. */
export function Breadcrumbs({ path, homeLabel, onJump, maxItems = DEFAULT_MAX_ITEMS }: BreadcrumbsProps) {
  const entries = truncateBreadcrumb(breadcrumbItems(path, homeLabel), maxItems);
  const lastIdx = entries.length - 1;
  return (
    <nav
      aria-label={homeLabel}
      className="sticky top-0 z-40 flex h-9 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-3 text-[12px]"
    >
      {entries.map((entry, i) => {
        if (entry === ELLIPSIS) {
          return <span key={`e${i}`} className="shrink-0 text-[var(--text-3)]">… /</span>;
        }
        const isLast = i === lastIdx;
        return (
          <span key={entry.path || "home"} className="flex shrink-0 items-center gap-1">
            {isLast ? (
              <span aria-current="location" className="max-w-[40vw] truncate font-medium text-[var(--text)]">{entry.label}</span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onJump(entry.path)}
                  className="max-w-[30vw] truncate text-[var(--accent)] hover:underline"
                >
                  {entry.label}
                </button>
                <span aria-hidden="true" className="text-[var(--text-3)]">/</span>
              </>
            )}
          </span>
        );
      })}
    </nav>
  );
}
