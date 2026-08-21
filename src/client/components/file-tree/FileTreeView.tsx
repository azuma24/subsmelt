import type { CSSProperties, ReactNode } from "react";
import { Breadcrumbs } from "./Breadcrumbs";
import { folderRowMode, indentPx, type FolderRowMode } from "./responsive";
import type { TreeExpansion } from "./use-persisted-expansion";
import type { DrillDownState } from "./use-drill-down";

/** Uniform folder-header height; the depth-1 sticky slot pins below depth 0. */
export const STICKY_HEADER_PX = 36;
/** Row content starts here; indent is added on top per level. */
export const ROW_BASE_PADDING_PX = 12;

const ANCESTOR_HINT_DEPTH = 2;
const ANCESTOR_HINT_SEGMENTS = 2;
const RAIL_CHEVRON_CENTER_PX = 5;

export interface FolderRowContext {
  depth: number;
  open: boolean;
  mode: FolderRowMode;
  /** Left padding the row should apply (base + capped indent). */
  padLeftPx: number;
  /** Expand/collapse (inline) or navigate into the folder (drill). */
  onActivate: () => void;
  /** "… / parent" context shown from depth 2 on, where headers stop stacking. */
  ancestorHint: string | null;
}

export interface FileRowContext {
  depth: number;
  padLeftPx: number;
}

/** Minimal structural node the view can walk; PathTreeNode<F> satisfies it. */
export interface TreeViewNode<F> {
  name: string;
  path: string;
  children: TreeViewNode<F>[];
  files: F[];
}

interface FileTreeViewProps<F, N extends TreeViewNode<F> & { children: N[] }> {
  roots: readonly N[];
  /** Files living directly at the library root. */
  rootFiles: readonly F[];
  isMobile: boolean;
  expansion: TreeExpansion;
  drill: DrillDownState<N>;
  homeLabel: string;
  renderFolderRow: (node: N, ctx: FolderRowContext) => ReactNode;
  renderFile: (file: F, ctx: FileRowContext) => ReactNode;
  fileKey: (file: F) => string;
  /** Optional block between a folder header and its children (e.g. inline editors). */
  renderAfterHeader?: (node: N) => ReactNode;
  /** Sticky headers need uniform ~36px header rows; opt out for tall rows. */
  sticky?: boolean;
}

/**
 * Structural shell shared by every file-tree panel: indentation, tree rails,
 * sticky folder headers (two slots deep, then an ancestor-hint breadcrumb in
 * the second slot), and mobile drill-down with a breadcrumb bar. Row content
 * stays with the panel via render props.
 */
export function FileTreeView<F, N extends TreeViewNode<F> & { children: N[] }>(props: FileTreeViewProps<F, N>) {
  const { drill, homeLabel, renderFile, fileKey } = props;
  const nodes = drill.current ? drill.current.children : props.roots;
  const files = drill.current ? drill.current.files : props.rootFiles;
  return (
    <div>
      {drill.path !== "" && <Breadcrumbs path={drill.path} homeLabel={homeLabel} onJump={drill.jumpTo} />}
      {nodes.map((node) => (
        <FolderBlock key={node.path} {...props} node={node} depth={0} />
      ))}
      {files.map((f) => (
        <div key={fileKey(f)}>{renderFile(f, { depth: 0, padLeftPx: ROW_BASE_PADDING_PX })}</div>
      ))}
    </div>
  );
}

function ancestorHint(nodePath: string, drillRoot: string): string | null {
  const rel = drillRoot && nodePath.startsWith(`${drillRoot}/`) ? nodePath.slice(drillRoot.length + 1) : nodePath;
  const parents = rel.split("/").slice(0, -1);
  if (parents.length === 0) return null;
  const shown = parents.slice(-ANCESTOR_HINT_SEGMENTS).join(" / ");
  return parents.length > ANCESTOR_HINT_SEGMENTS ? `… / ${shown}` : shown;
}

function FolderBlock<F, N extends TreeViewNode<F> & { children: N[] }>(props: FileTreeViewProps<F, N> & { node: N; depth: number }) {
  const { node, depth, isMobile, expansion, drill, sticky = true } = props;
  const mode = folderRowMode(depth, isMobile);
  const open = mode === "inline" && expansion.expanded.has(node.path);
  const pad = ROW_BASE_PADDING_PX + indentPx(depth, isMobile);
  const childPad = ROW_BASE_PADDING_PX + indentPx(depth + 1, isMobile);

  // Two sticky slots: depth 0 pins at the top, depth 1 pins right below it.
  // Deeper headers reuse the second slot (later DOM order paints over the
  // shallower one) and carry an ancestor hint instead of stacking further.
  // While drilled in, the breadcrumb bar owns the top-0 slot, so every sticky
  // header shifts down one slot instead of fighting it for the same offset.
  const stickyHere = sticky && mode === "inline";
  const drillOffset = drill.path !== "" ? STICKY_HEADER_PX : 0;
  const headerClass = stickyHere ? (depth === 0 ? "sticky z-30" : "sticky z-20") : "";
  const headerStyle: CSSProperties | undefined = stickyHere
    ? { top: drillOffset + (depth === 0 ? 0 : STICKY_HEADER_PX) }
    : undefined;

  const ctx: FolderRowContext = {
    depth,
    open,
    mode,
    padLeftPx: pad,
    onActivate: mode === "drill" ? () => drill.enter(node.path) : () => expansion.toggleExpand(node.path),
    ancestorHint: depth >= ANCESTOR_HINT_DEPTH ? ancestorHint(node.path, drill.path) : null,
  };

  return (
    <div>
      <div className={headerClass} style={headerStyle}>
        {props.renderFolderRow(node, ctx)}
      </div>
      {props.renderAfterHeader?.(node)}
      {open && (
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--border-sub)]"
            style={{ left: pad + RAIL_CHEVRON_CENTER_PX }}
          />
          {/* The constraint guarantees children: N[]; TS resolves the
              intersection property to the wider branch, hence the assert. */}
          {(node.children as N[]).map((child) => (
            <FolderBlock key={child.path} {...props} node={child} depth={depth + 1} />
          ))}
          {node.files.map((f) => (
            <div key={props.fileKey(f)}>{props.renderFile(f, { depth: depth + 1, padLeftPx: childPad })}</div>
          ))}
        </div>
      )}
    </div>
  );
}
