import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import type { FolderNode } from "../../types";
import { Icon } from "../../ui/Icon";
import { folderTrail, statsFor, type FolderStats } from "./folder-scope";

const OPEN_KEY = "subsmelt.library.folders.open";
const PINNED_KEY = "subsmelt.library.folders.pinned";

function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, values: Iterable<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // Private mode or storage off: the choice lasts for this page only.
  }
}

/** Every folder in the tree by its path, for the header and the pinned list. */
export function indexFolders(
  nodes: readonly FolderNode[],
  out = new Map<string, FolderNode>(),
): Map<string, FolderNode> {
  for (const node of nodes) {
    out.set(node.path, node);
    indexFolders(node.children, out);
  }
  return out;
}

interface FolderTreeProps {
  root: FolderNode;
  /** Selected folder path, or "all". */
  selected: string;
  /** Per-folder totals from the Library's own rows (see folderStats). */
  stats: ReadonlyMap<string, FolderStats>;
  onSelect: (folder: string) => void;
}

/**
 * The Library's folders as a tree: each with its file count and a red dot
 * when a translation in it failed. Picking a folder shows it with its
 * subfolders. Which branches are open and which folders are pinned are
 * remembered in this browser.
 */
export function FolderTree({ root, selected, stats, onSelect }: FolderTreeProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(() => new Set(readList(OPEN_KEY)));
  const [pinned, setPinned] = useState<string[]>(() => readList(PINNED_KEY));
  const byPath = useMemo(() => indexFolders(root.children), [root]);

  // The selected folder is always visible: its ancestors open with it (a link, a breadcrumb click).
  useEffect(() => {
    if (selected === "all") return;
    const ancestors = folderTrail(selected).slice(0, -1);
    if (ancestors.every((a) => open.has(a))) return;
    setOpen((current) => {
      const next = new Set([...current, ...ancestors]);
      writeList(OPEN_KEY, next);
      return next;
    });
  }, [selected, open]);

  const toggleOpen = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      writeList(OPEN_KEY, next);
      return next;
    });
  const togglePin = (path: string) =>
    setPinned((current) => {
      const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
      writeList(PINNED_KEY, next);
      return next;
    });

  const livePins = pinned.filter((p) => byPath.has(p));

  return (
    <nav aria-label={t("library.folders.title")} className="space-y-3 text-sm">
      <ul>
        <Row
          label={t("library.folders.all")}
          count={statsFor(stats, "").files}
          errors={statsFor(stats, "").errors}
          depth={0}
          selected={selected === "all"}
          onSelect={() => onSelect("all")}
        />
      </ul>
      {livePins.length > 0 && (
        <div>
          <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
            {t("library.folders.pinned")}
          </h3>
          <ul>
            {livePins.map((path) => {
              return (
                <Row
                  key={path}
                  label={path}
                  count={statsFor(stats, path).files}
                  errors={statsFor(stats, path).errors}
                  depth={0}
                  selected={selected === path}
                  onSelect={() => onSelect(path)}
                  pinned
                  onTogglePin={() => togglePin(path)}
                />
              );
            })}
          </ul>
        </div>
      )}
      <div>
        <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t("library.folders.title")}
        </h3>
        {root.children.length === 0 ? (
          <p className="px-2 text-xs text-faint">{t("library.folders.none")}</p>
        ) : (
          <ul>
            {root.children.map((node) => (
              <Branch
                key={node.path}
                node={node}
                depth={0}
                selected={selected}
                stats={stats}
                open={open}
                pinned={pinned}
                onSelect={onSelect}
                onToggleOpen={toggleOpen}
                onTogglePin={togglePin}
              />
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

function Branch({
  node,
  depth,
  selected,
  stats,
  open,
  pinned,
  onSelect,
  onToggleOpen,
  onTogglePin,
}: {
  node: FolderNode;
  depth: number;
  selected: string;
  stats: ReadonlyMap<string, FolderStats>;
  open: ReadonlySet<string>;
  pinned: readonly string[];
  onSelect: (folder: string) => void;
  onToggleOpen: (path: string) => void;
  onTogglePin: (path: string) => void;
}) {
  const expanded = open.has(node.path);
  return (
    <>
      <Row
        label={node.name}
        title={node.path}
        count={statsFor(stats, node.path).files}
        errors={statsFor(stats, node.path).errors}
        depth={depth}
        selected={selected === node.path}
        onSelect={() => onSelect(node.path)}
        expanded={node.children.length ? expanded : undefined}
        onToggleOpen={() => onToggleOpen(node.path)}
        pinned={pinned.includes(node.path)}
        onTogglePin={() => onTogglePin(node.path)}
      />
      {expanded &&
        node.children.map((child) => (
          <Branch
            key={child.path}
            node={child}
            depth={depth + 1}
            selected={selected}
            stats={stats}
            open={open}
            pinned={pinned}
            onSelect={onSelect}
            onToggleOpen={onToggleOpen}
            onTogglePin={onTogglePin}
          />
        ))}
    </>
  );
}

function Row({
  label,
  title,
  count,
  errors,
  depth,
  selected,
  onSelect,
  expanded,
  onToggleOpen,
  pinned,
  onTogglePin,
}: {
  label: string;
  title?: string;
  count: number;
  errors: number;
  depth: number;
  selected: boolean;
  onSelect: () => void;
  /** Undefined for a folder with no subfolders. */
  expanded?: boolean;
  onToggleOpen?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={`group flex items-center gap-1 rounded-sm pr-1 ${selected ? "bg-accent-soft text-accent" : "text-text hover:bg-surface-raised"}`}
      style={{ paddingLeft: `${depth * 14 + 2}px` }}
    >
      {expanded === undefined ? (
        <span className="w-6 shrink-0" />
      ) : (
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={expanded}
          aria-label={t(expanded ? "library.folders.collapse" : "library.folders.expand", { folder: label })}
          className="inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-sm text-faint hover:text-text"
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={16} />
        </button>
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={title ?? label}
        className="flex min-h-[32px] min-w-0 flex-1 items-center gap-2 py-1 text-left"
      >
        <Icon
          name={expanded ? "folder-open" : "folder"}
          size={16}
          className="shrink-0 text-faint @max-[140px]:hidden"
        />
        <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : ""}`}>{label}</span>
        {errors > 0 && (
          <span
            title={t("library.folders.errors", { count: errors })}
            className="h-2 w-2 shrink-0 rounded-full bg-danger"
          >
            <span className="sr-only">{t("library.folders.errors", { count: errors })}</span>
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint @max-[180px]:hidden">{count}</span>
      </button>
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          aria-label={t(pinned ? "library.folders.unpin" : "library.folders.pin", { folder: label })}
          className={`inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-sm hover:text-text @max-[180px]:hidden ${pinned ? "text-accent" : "text-faint opacity-0 focus:opacity-100 group-hover:opacity-100"}`}
        >
          <Icon name="pinned" size={16} />
        </button>
      )}
    </li>
  );
}
