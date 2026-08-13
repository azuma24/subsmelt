import { useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { FolderNode, Task } from "../../../types";
import {
  TRI_STATES,
  hasDescendant,
  pathMatchesScope,
  type DirectoryRule,
  type ScanMode,
  type TriState,
} from "./model";

interface FolderTreeSharedProps {
  tasks: Task[];
  rules: DirectoryRule[];
  upsertRule: (path: string, patch: Partial<Pick<DirectoryRule, "translateWithoutVideo" | "taskIds">>) => void;
  removeRuleForPath: (path: string) => void;
}

/** Everything a row needs that is identical for every row in the tree. */
interface FolderTreeContext extends FolderTreeSharedProps {
  mediaDir: string;
  mode: ScanMode;
  selected: string[];
  excluded: string[];
  expandedFolders: Set<string>;
  setExpandedFolders: Dispatch<SetStateAction<Set<string>>>;
  searchActive: boolean;
  onToggleIncluded: (folder: string) => void;
  onToggleExcluded: (folder: string) => void;
}

interface FolderTreeProps extends FolderTreeContext {
  nodes: FolderNode[];
}

export function FolderTree({ nodes, ...rest }: FolderTreeProps) {
  return (
    <div className="space-y-1">
      {nodes.map((node) => (
        <FolderTreeRow key={node.path} node={node} depth={0} {...rest} />
      ))}
    </div>
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
    <div className="mx-1 mb-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5">
      <div className="mb-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-3)]">
          {t("settings.sources.dirRules.videolessLabel")}
        </div>
        <div className="inline-flex overflow-hidden rounded-lg border border-[var(--border)]">
          {TRI_STATES.map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => handleTriState(state)}
              aria-pressed={currentTwv === state}
              className={`px-2.5 py-1 text-[11px] ${currentTwv === state ? "bg-[var(--accent)] text-[var(--on-accent)]" : "bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)]"}`}
            >
              {triLabel(state)}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-3)]">
          {t("settings.sources.dirRules.languagesLabel")}
        </div>
        {tasks.length === 0 ? (
          <p className="text-[10.5px] text-[var(--text-3)]">{t("settings.sources.dirRules.noTasks")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tasks.map((task) => (
              <label
                key={task.id}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${currentTaskIds.includes(task.id) ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)]"}`}
              >
                <input
                  type="checkbox"
                  checked={currentTaskIds.includes(task.id)}
                  onChange={() => handleToggleTask(task.id)}
                  className="h-3 w-3 accent-[var(--accent)]"
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
            className="rounded-md px-2 py-1 text-[10px] text-[var(--text-3)] hover:text-[var(--red)]"
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
  depth,
  mediaDir,
  mode,
  selected,
  excluded,
  expandedFolders,
  setExpandedFolders,
  searchActive,
  onToggleIncluded,
  onToggleExcluded,
  tasks,
  rules,
  upsertRule,
  removeRuleForPath,
}: FolderTreeContext & { node: FolderNode; depth: number }) {
  const { t } = useTranslation();
  const hasChildren = node.children.length > 0;
  const expanded = searchActive || expandedFolders.has(node.path);
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

  const toggleExpanded = () => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

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

  return (
    <div>
      <div
        className={`mb-[2px] flex items-center gap-2 rounded-[6px] border px-2 py-2 transition-colors ${
          excludedHere
            ? "border-[var(--red-border)] bg-[var(--red-dim)]"
            : checked
              ? "border-[var(--accent-border)] bg-[var(--accent-dim)]"
              : "border-[var(--border-sub)] bg-[var(--surface-3)]"
        }`}
        style={{ paddingLeft: `${8 + depth * 18}px` }}
      >
        <button
          type="button"
          onClick={toggleExpanded}
          disabled={!hasChildren}
          className="h-6 w-6 shrink-0 rounded-md text-xs text-[var(--text-3)] hover:bg-[var(--surface-2)] disabled:opacity-20"
          aria-label={expanded ? t("settings.sources.collapseFolder") : t("settings.sources.expandFolder")}
        >
          {hasChildren ? (expanded ? "▾" : "▸") : ""}
        </button>
        {interactive && (
          <input
            type="checkbox"
            checked={checked}
            aria-label={node.name}
            ref={(el) => {
              if (el) el.indeterminate = mixed;
            }}
            onChange={() => onToggleIncluded(node.path)}
            className="h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-[var(--text)]">{node.name}</div>
          <div className="truncate font-mono text-[10px] text-[var(--text-3)]">{mediaDir}/{node.path}</div>
          <div className="mt-1 flex flex-wrap gap-1 text-[9.5px] text-[var(--text-2)]">
            <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5">{t("settings.sources.folderCountVideos", { count: node.counts.videos })}</span>
            <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5">{t("settings.sources.folderCountSubtitles", { count: node.counts.subtitles })}</span>
            {node.counts.pendingJobs > 0 && <span className="rounded-full border border-[var(--yellow-border)] bg-[var(--yellow-dim)] px-2 py-0.5 text-[var(--yellow)]">{t("settings.sources.folderCountPending", { count: node.counts.pendingJobs })}</span>}
            {node.counts.completeJobs > 0 && <span className="rounded-full border border-[var(--green-border)] bg-[var(--green-dim)] px-2 py-0.5 text-[var(--green)]">{t("settings.sources.folderCountComplete", { count: node.counts.completeJobs })}</span>}
            {node.counts.errorJobs > 0 && <span className="rounded-full border border-[var(--red-border)] bg-[var(--red-dim)] px-2 py-0.5 text-[var(--red)]">{t("settings.sources.folderCountErrors", { count: node.counts.errorJobs })}</span>}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold ${
          excludedHere ? "bg-[var(--red-dim)] text-[var(--red)]" : checked ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "bg-[var(--surface)] text-[var(--text-3)]"
        }`}>
          {excludedHere ? t("settings.sources.excludedBadge") : checked ? t("settings.sources.includedBadge") : t("settings.sources.notIncludedBadge")}
        </span>
        {interactive && (checked || excludedHere) && (
          <button
            type="button"
            onClick={() => onToggleExcluded(node.path)}
            className={`rounded-[5px] px-2 py-1 text-[10px] font-medium ${
              excludedHere ? "bg-[var(--surface-3)] text-[var(--text-2)] hover:text-[var(--text)]" : "bg-[var(--red-dim)] text-[var(--red)] hover:brightness-110"
            }`}
          >
            {excludedHere ? t("settings.sources.allowFolder") : t("settings.sources.excludeFolder")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setRulesOpen((prev) => !prev)}
          className={`shrink-0 rounded-[5px] border px-2 py-1 text-[10px] font-medium transition-colors ${
            hasRule
              ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)] hover:brightness-110"
              : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-3)] hover:text-[var(--text)]"
          }`}
          aria-expanded={rulesOpen}
        >
          {t("settings.sources.dirRules.rulesButton")}
          {hasRule && ruleSummaryChip !== null && (
            <span className="ml-1 opacity-75">{ruleSummaryChip}</span>
          )}
        </button>
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
      {hasChildren && expanded && (
        <div className="mt-1 space-y-1">
          {node.children.map((child) => (
            <FolderTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              mediaDir={mediaDir}
              mode={mode}
              selected={selected}
              excluded={excluded}
              expandedFolders={expandedFolders}
              setExpandedFolders={setExpandedFolders}
              searchActive={searchActive}
              onToggleIncluded={onToggleIncluded}
              onToggleExcluded={onToggleExcluded}
              tasks={tasks}
              rules={rules}
              upsertRule={upsertRule}
              removeRuleForPath={removeRuleForPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}
