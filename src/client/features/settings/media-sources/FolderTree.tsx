import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FolderNode, Task } from "../../../types";
import { FileTreeView, type FolderRowContext } from "../../../components/file-tree/FileTreeView";
import type { TreeExpansion } from "../../../components/file-tree/use-persisted-expansion";
import type { DrillDownState } from "../../../components/file-tree/use-drill-down";
import {
  TRI_STATES,
  hasDescendant,
  pathMatchesScope,
  type DirectoryRule,
  type ScanMode,
  type TriState,
} from "./model";

/**
 * FolderNode carries no `files` field (Settings folders have no per-file
 * rows), but FileTreeView's generic shell requires one on every node. This
 * adapts the API tree once, immutably, into the shape FileTreeView needs.
 */
export type SettingsTreeNode = Omit<FolderNode, "children"> & {
  children: SettingsTreeNode[];
  files: never[];
};

export function toSettingsTree(nodes: FolderNode[]): SettingsTreeNode[] {
  return nodes.map((node) => ({ ...node, children: toSettingsTree(node.children), files: [] }));
}

interface FolderTreeSharedProps {
  tasks: Task[];
  rules: DirectoryRule[];
  upsertRule: (path: string, patch: Partial<Pick<DirectoryRule, "translateWithoutVideo" | "taskIds">>) => void;
  removeRuleForPath: (path: string) => void;
}

/** Everything a row needs that is identical for every row in the tree. */
interface FolderTreeRowSharedProps extends FolderTreeSharedProps {
  mediaDir: string;
  mode: ScanMode;
  selected: string[];
  excluded: string[];
  onToggleIncluded: (folder: string) => void;
  onToggleExcluded: (folder: string) => void;
}

export interface FolderTreeProps extends FolderTreeRowSharedProps {
  nodes: SettingsTreeNode[];
  isMobile: boolean;
  expansion: TreeExpansion;
  drill: DrillDownState<SettingsTreeNode>;
}

/**
 * Structural shell (indent, rails, sticky-off tall rows, mobile drill-down)
 * comes from the shared FileTreeView; this component only supplies row
 * content via FolderTreeRow. Rows are tall (checkbox + counts + rules
 * button), hence `sticky={false}` — the view's sticky offsets assume 36px.
 */
export function FolderTree({ nodes, isMobile, expansion, drill, ...rowProps }: FolderTreeProps) {
  const { t } = useTranslation();
  return (
    <FileTreeView
      sticky={false}
      roots={nodes}
      rootFiles={[]}
      isMobile={isMobile}
      expansion={expansion}
      drill={drill}
      homeLabel={t("common.home")}
      fileKey={() => ""}
      renderFile={() => null}
      renderFolderRow={(node, ctx) => <FolderTreeRow node={node} ctx={ctx} {...rowProps} />}
    />
  );
}

function FolderRulesEditor({
  path,
  rule,
  tasks,
  upsertRule,
  removeRuleForPath,
  onClose,
}: {
  path: string;
  rule: DirectoryRule | undefined;
  tasks: Task[];
  upsertRule: (path: string, patch: Partial<Pick<DirectoryRule, "translateWithoutVideo" | "taskIds">>) => void;
  removeRuleForPath: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const currentTwv: TriState = rule?.translateWithoutVideo ?? "inherit";
  const currentTaskIds: number[] = rule?.taskIds ?? [];

  const triLabel = (state: TriState): string => t(`settings.sources.dirRules.tri_${state}`);

  const handleTriState = (state: TriState) => {
    upsertRule(path, { translateWithoutVideo: state, taskIds: currentTaskIds });
  };

  const handleToggleTask = (taskId: number) => {
    const nextIds = currentTaskIds.includes(taskId)
      ? currentTaskIds.filter((n) => n !== taskId)
      : [...currentTaskIds, taskId];
    upsertRule(path, { translateWithoutVideo: currentTwv, taskIds: nextIds });
  };

  const handleRemove = () => {
    removeRuleForPath(path);
    onClose();
  };

  return (
    <div className="mx-1 mb-2 rounded-sm border border-border bg-surface p-3">
      <div className="mb-2">
        <div className="mb-1 text-xs uppercase tracking-wide text-faint">
          {t("settings.sources.dirRules.videolessLabel")}
        </div>
        <div className="inline-flex overflow-hidden rounded-sm border border-border">
          {TRI_STATES.map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => handleTriState(state)}
              aria-pressed={currentTwv === state}
              className={`px-3 py-1 text-xs min-h-touch md:min-h-0 ${currentTwv === state ? "bg-accent text-accent-text" : "bg-surface-raised text-muted hover:text-text"}`}
            >
              {triLabel(state)}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div className="mb-1 text-xs uppercase tracking-wide text-faint">
          {t("settings.sources.dirRules.languagesLabel")}
        </div>
        {tasks.length === 0 ? (
          <p className="text-xs text-faint">{t("settings.sources.dirRules.noTasks")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tasks.map((task) => (
              <label
                key={task.id}
                className={`flex min-h-touch cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-xs md:min-h-0 ${currentTaskIds.includes(task.id) ? "border-accent-line bg-accent-soft text-accent" : "border-border bg-surface-raised text-muted"}`}
              >
                <input
                  type="checkbox"
                  checked={currentTaskIds.includes(task.id)}
                  onChange={() => handleToggleTask(task.id)}
                  className="h-3 w-3 accent-accent"
                />
                {task.target_lang}
              </label>
            ))}
          </div>
        )}
      </div>

      {rule !== undefined && (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={handleRemove}
            className="rounded-sm px-2 py-1 text-xs text-faint hover:text-danger"
          >
            {t("common.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

function FolderTreeRow({
  node,
  ctx,
  mediaDir,
  mode,
  selected,
  excluded,
  onToggleIncluded,
  onToggleExcluded,
  tasks,
  rules,
  upsertRule,
  removeRuleForPath,
}: FolderTreeRowSharedProps & { node: SettingsTreeNode; ctx: FolderRowContext }) {
  const { t } = useTranslation();
  const hasChildren = node.children.length > 0;
  const isDrill = ctx.mode === "drill";
  const ownSelected = selected.includes(node.path);
  const included = mode === "recursive" || pathMatchesScope(node.path, selected);
  const excludedHere = pathMatchesScope(node.path, excluded);
  const selectedDescendant = hasDescendant(node.path, selected);
  const excludedDescendant = hasDescendant(node.path, excluded);
  const interactive = mode === "selected";
  const checked = included && !excludedHere;
  const mixed = (ownSelected && excludedDescendant) || (!ownSelected && selectedDescendant);

  const [rulesOpen, setRulesOpen] = useState(false);

  const rule = rules.find((r) => r.path === node.path);
  const hasRule = rule !== undefined;

  const ruleSummaryChip = (() => {
    if (!hasRule) return null;
    const parts: string[] = [];
    if (rule.translateWithoutVideo !== "inherit") {
      parts.push(t("settings.sources.dirRules.chipNoVideo", { state: t(`settings.sources.dirRules.tri_${rule.translateWithoutVideo}`) }));
    }
    if (rule.taskIds.length > 0) {
      parts.push(t("settings.sources.dirRules.chipLangs", { count: rule.taskIds.length }));
    }
    return parts.length > 0 ? parts.join(", ") : null;
  })();

  const body = (
    <>
      <div className="truncate text-xs font-medium text-text">
        {ctx.ancestorHint && <span className="text-xs font-normal text-faint">{ctx.ancestorHint} / </span>}
        {node.name}
      </div>
      <div className="truncate font-mono text-xs text-faint">{mediaDir}/{node.path}</div>
      <div className="mt-1 flex flex-wrap gap-1 whitespace-nowrap text-xs text-muted">
        <span className="rounded-full border border-border bg-surface px-2 py-1">{t("settings.sources.folderCountVideos", { count: node.counts.videos })}</span>
        <span className="rounded-full border border-border bg-surface px-2 py-1">{t("settings.sources.folderCountSubtitles", { count: node.counts.subtitles })}</span>
        {node.counts.pendingJobs > 0 && <span className="rounded-full border border-warning-line bg-warning-soft px-2 py-1 text-warning">{t("settings.sources.folderCountPending", { count: node.counts.pendingJobs })}</span>}
        {node.counts.completeJobs > 0 && <span className="rounded-full border border-success-line bg-success-soft px-2 py-1 text-success">{t("settings.sources.folderCountComplete", { count: node.counts.completeJobs })}</span>}
        {node.counts.errorJobs > 0 && <span className="rounded-full border border-danger-line bg-danger-soft px-2 py-1 text-danger">{t("settings.sources.folderCountErrors", { count: node.counts.errorJobs })}</span>}
      </div>
    </>
  );

  return (
    <div>
      <div
        className={`mb-1 flex items-center gap-2 rounded-sm border px-2 py-2 transition-colors ${
          excludedHere
            ? "border-danger-line bg-danger-soft"
            : checked
              ? "border-accent-line bg-accent-soft"
              : "border-border-subtle bg-surface-highlight"
        }`}
        style={{ paddingLeft: `${ctx.padLeftPx}px` }}
      >
        {!isDrill && (
          <button
            type="button"
            onClick={ctx.onActivate}
            disabled={!hasChildren}
            className="h-6 min-h-touch w-6 shrink-0 rounded-sm text-xs text-faint hover:bg-surface-raised disabled:opacity-20 md:min-h-0"
            aria-label={ctx.open ? t("settings.sources.collapseFolder") : t("settings.sources.expandFolder")}
          >
            {hasChildren ? (ctx.open ? "▾" : "▸") : ""}
          </button>
        )}
        {interactive && (
          <input
            type="checkbox"
            checked={checked}
            aria-label={node.name}
            ref={(el) => {
              if (el) el.indeterminate = mixed;
            }}
            onChange={() => onToggleIncluded(node.path)}
            className="h-4 w-4 shrink-0 accent-accent"
          />
        )}
        {/* A childless folder has nothing to drill into — keep it a plain row
            rather than navigating to an empty list. */}
        {isDrill && hasChildren ? (
          <button
            type="button"
            onClick={ctx.onActivate}
            aria-label={t("common.openFolder", { name: node.name })}
            className="min-w-0 flex-1 text-left"
          >
            {body}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{body}</div>
        )}
        <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${
          excludedHere ? "bg-danger-soft text-danger" : checked ? "bg-accent-soft text-accent" : "bg-surface text-faint"
        }`}>
          {excludedHere ? t("settings.sources.excludedBadge") : checked ? t("settings.sources.includedBadge") : t("settings.sources.notIncludedBadge")}
        </span>
        {interactive && (checked || excludedHere) && (
          <button
            type="button"
            onClick={() => onToggleExcluded(node.path)}
            className={`rounded-sm px-2 py-1 text-xs font-medium ${
              excludedHere ? "bg-surface-highlight text-muted hover:text-text" : "bg-danger-soft text-danger hover:brightness-110"
            }`}
          >
            {excludedHere ? t("settings.sources.allowFolder") : t("settings.sources.excludeFolder")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setRulesOpen((prev) => !prev)}
          className={`shrink-0 rounded-sm border px-2 py-1 text-xs font-medium transition-colors min-h-touch md:min-h-0 ${
            hasRule
              ? "border-accent-line bg-accent-soft text-accent hover:brightness-110"
              : "border-border bg-surface-raised text-faint hover:text-text"
          }`}
          aria-expanded={rulesOpen}
        >
          {t("settings.sources.dirRules.rulesButton")}
          {hasRule && ruleSummaryChip !== null && (
            <span className="ml-1 opacity-75">{ruleSummaryChip}</span>
          )}
        </button>
        {isDrill && hasChildren && <span aria-hidden="true" className="shrink-0 text-faint">›</span>}
      </div>
      {rulesOpen && (
        <FolderRulesEditor
          path={node.path}
          rule={rule}
          tasks={tasks}
          upsertRule={upsertRule}
          removeRuleForPath={removeRuleForPath}
          onClose={() => setRulesOpen(false)}
        />
      )}
    </div>
  );
}
