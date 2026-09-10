import { useTranslation } from "react-i18next";
import type { FolderRowContext } from "../../components/file-tree/FileTreeView";
import type { TreeNode } from "./folderTree";

export interface FolderNodeViewProps {
  node: TreeNode;
  ctx: FolderRowContext;
  selected: Set<string>;
  running: boolean;
  toggleFolder: (paths: string[]) => void;
}

/**
 * Folder header content for the whisper library tree. Structure (indent,
 * rails, sticky slots, drill-down) comes from FileTreeView; this row only
 * renders the caret/checkbox/name controls at a fixed 36px height so the
 * sticky offsets in the view hold.
 */
export function FolderNodeView({ node, ctx, selected, running, toggleFolder }: FolderNodeViewProps) {
  const { t } = useTranslation();
  const allSel = node.allPaths.length > 0 && node.allPaths.every((p) => selected.has(p));
  const someSel = !allSel && node.allPaths.some((p) => selected.has(p));
  const isDrill = ctx.mode === "drill";
  return (
    <div className="flex h-9 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 text-[12px] font-medium text-[var(--text)]"
      style={{ paddingLeft: `${ctx.padLeftPx}px` }}>
      {/* The caret, the checkbox and the name button are three distinct
          controls; each needs a name describing its own action, or a screen
          reader just hears the folder name three times in a row. */}
      {!isDrill && (
        <button type="button" onClick={ctx.onActivate} className="w-3 shrink-0 text-[var(--text-3)]" aria-label={t("whisper.toggleFolder", { name: node.name })} aria-expanded={ctx.open}>
          <span aria-hidden="true">{ctx.open ? "▾" : "▸"}</span>
        </button>
      )}
      <input
        type="checkbox"
        aria-label={t("whisper.selectFolder", { name: node.name })}
        checked={allSel}
        disabled={running}
        ref={(el) => { if (el) el.indeterminate = someSel; }}
        onChange={() => toggleFolder(node.allPaths)}
        className="h-4 w-4 accent-[var(--accent)]"
      />
      <button
        type="button"
        onClick={ctx.onActivate}
        aria-label={isDrill ? t("common.openFolder", { name: node.name }) : t("whisper.toggleFolder", { name: node.name })}
        aria-expanded={isDrill ? undefined : ctx.open}
        className="flex min-w-0 flex-1 items-center gap-1 truncate text-left"
      >
        {/* From depth 2 the sticky stack stops growing, so pinned deep headers
            carry their ancestor path inline instead. */}
        {ctx.ancestorHint && <span className="shrink-0 text-[10px] font-normal text-[var(--text-3)]">{ctx.ancestorHint} /</span>}
        <span className="truncate"><span aria-hidden="true">📁</span> {node.name}</span>
        <span className="shrink-0 text-[10px] text-[var(--text-3)]">({node.allPaths.length})</span>
      </button>
      {isDrill && <span aria-hidden="true" className="shrink-0 text-[var(--text-3)]">›</span>}
    </div>
  );
}
