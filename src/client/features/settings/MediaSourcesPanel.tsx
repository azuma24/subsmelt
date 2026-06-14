import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type { FolderNode, Task } from "../../types";

type ScanMode = "recursive" | "root_only" | "selected";
type TriState = "inherit" | "on" | "off";

interface DirectoryRule {
  id: string;
  path: string;
  enabled: boolean;
  translateWithoutVideo: TriState;
  taskIds: number[];
}

interface MediaSourcesPanelProps {
  isMobile: boolean;
  mediaDir: string;
  scanMode: string;
  scanFolders: string;
  scanExcludeFolders: string;
  scanProfiles: string;
  directoryRules: string;
  onScanModeChange: (mode: string) => void;
  onScanFoldersChange: (folders: string) => void;
  onScanExcludeFoldersChange: (folders: string) => void;
  onScanScopeChange: (scope: { scanMode: string; scanFolders: string; scanExcludeFolders: string }) => void;
  onScanProfilesChange: (profiles: string) => void;
  onDirectoryRulesChange: (rules: string) => void;
}

const TRI_STATES: TriState[] = ["inherit", "on", "off"];

const parseDirectoryRules = (raw: string): DirectoryRule[] => {
  try {
    const value = JSON.parse(raw || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter((r) => r && typeof r === "object" && typeof r.id === "string")
      .map((r) => ({
        id: r.id as string,
        path: typeof r.path === "string" ? r.path.replace(/^\/+|\/+$/g, "") : "",
        enabled: r.enabled !== false,
        translateWithoutVideo: (TRI_STATES as string[]).includes(r.translateWithoutVideo) ? r.translateWithoutVideo as TriState : "inherit",
        taskIds: Array.isArray(r.taskIds) ? r.taskIds.filter((n: unknown) => typeof n === "number") : [],
      }));
  } catch {
    return [];
  }
};

const serializeDirectoryRules = (rules: DirectoryRule[]): string => JSON.stringify(rules);

const createRuleId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const SCAN_MODES: ScanMode[] = ["recursive", "root_only", "selected"];

interface ScanProfile {
  id: string;
  name: string;
  scanMode: ScanMode;
  scanFolders: string;
  scanExcludeFolders: string;
}

const parseFolders = (raw: string): string[] =>
  raw.split(",").map((f) => f.trim()).filter(Boolean);

const serializeFolders = (folders: string[]): string =>
  Array.from(new Set(folders)).filter(Boolean).join(",");

const createProfileId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const parseProfiles = (raw: string): ScanProfile[] => {
  try {
    const value = JSON.parse(raw || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .map((profile) => ({
        id: typeof profile.id === "string" ? profile.id : createProfileId(),
        name: typeof profile.name === "string" ? profile.name : "",
        scanMode: (SCAN_MODES as string[]).includes(profile.scanMode) ? profile.scanMode as ScanMode : "recursive",
        scanFolders: typeof profile.scanFolders === "string" ? profile.scanFolders : "",
        scanExcludeFolders: typeof profile.scanExcludeFolders === "string" ? profile.scanExcludeFolders : "",
      }))
      .filter((profile) => profile.name.trim().length > 0);
  } catch {
    return [];
  }
};

const serializeProfiles = (profiles: ScanProfile[]): string =>
  JSON.stringify(profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    scanMode: profile.scanMode,
    scanFolders: profile.scanFolders,
    scanExcludeFolders: profile.scanExcludeFolders,
  })));

function flattenFolderTree(nodes: FolderNode[], results: string[] = []): string[] {
  nodes.forEach((node) => {
    results.push(node.path);
    flattenFolderTree(node.children, results);
  });
  return results;
}

function collectNodePaths(nodes: FolderNode[], results: string[] = []): string[] {
  nodes.forEach((node) => {
    results.push(node.path);
    collectNodePaths(node.children, results);
  });
  return results;
}

function filterTree(nodes: FolderNode[], query: string): FolderNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  return nodes.flatMap((node) => {
    const matches = `${node.name} ${node.path}`.toLowerCase().includes(q);
    const children = filterTree(node.children, q);
    if (matches) return [node];
    if (children.length > 0) return [{ ...node, children }];
    return [];
  });
}

function pathMatchesScope(path: string, folders: string[]): boolean {
  return folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

function hasDescendant(path: string, folders: string[]): boolean {
  return folders.some((folder) => folder.startsWith(`${path}/`));
}

function withoutPathAndDescendants(folders: string[], path: string): string[] {
  return folders.filter((folder) => folder !== path && !folder.startsWith(`${path}/`));
}

export function MediaSourcesPanel({
  isMobile,
  mediaDir,
  scanMode,
  scanFolders,
  scanExcludeFolders,
  scanProfiles,
  directoryRules,
  onScanModeChange,
  onScanFoldersChange,
  onScanExcludeFoldersChange,
  onScanScopeChange,
  onScanProfilesChange,
  onDirectoryRulesChange,
}: MediaSourcesPanelProps) {
  const { t } = useTranslation();
  const [folderRoot, setFolderRoot] = useState<FolderNode | null>(null);
  const [folderSearch, setFolderSearch] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [profileName, setProfileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);

  const fetchSources = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFolderTree();
      setFolderRoot(data.root);
      setExpandedFolders(new Set(data.root.children.map((node) => node.path)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setFolderRoot(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchSources();
  }, []);

  useEffect(() => {
    let active = true;
    api.getTasks().then((data) => { if (active) setTasks(data); }).catch(() => { if (active) setTasks([]); });
    return () => { active = false; };
  }, []);

  const rules = useMemo(() => parseDirectoryRules(directoryRules), [directoryRules]);

  const upsertRule = (path: string, patch: Partial<Pick<DirectoryRule, "translateWithoutVideo" | "taskIds">>) => {
    const existing = rules.find((r) => r.path === path);
    let next: DirectoryRule[];
    if (existing) {
      next = rules.map((r) => r.path === path ? { ...r, ...patch } : r);
    } else {
      const newRule: DirectoryRule = {
        id: createRuleId(),
        path,
        enabled: true,
        translateWithoutVideo: patch.translateWithoutVideo ?? "on",
        taskIds: patch.taskIds ?? [],
      };
      next = [...rules, newRule];
    }
    onDirectoryRulesChange(serializeDirectoryRules(next));
  };

  const removeRuleForPath = (path: string) => {
    onDirectoryRulesChange(serializeDirectoryRules(rules.filter((r) => r.path !== path)));
  };

  const mode: ScanMode = (SCAN_MODES as string[]).includes(scanMode) ? (scanMode as ScanMode) : "recursive";
  const selected = useMemo(() => parseFolders(scanFolders), [scanFolders]);
  const excluded = useMemo(() => parseFolders(scanExcludeFolders), [scanExcludeFolders]);
  const profiles = useMemo(() => parseProfiles(scanProfiles), [scanProfiles]);
  const allSubfolders = useMemo(() => folderRoot ? flattenFolderTree(folderRoot.children) : [], [folderRoot]);
  const visibleTree = useMemo(() => filterTree(folderRoot?.children || [], folderSearch), [folderRoot, folderSearch]);
  const visibleFolders = useMemo(() => collectNodePaths(visibleTree), [visibleTree]);

  const toggleIncludedFolder = (folder: string) => {
    if (excluded.includes(folder)) {
      onScanExcludeFoldersChange(serializeFolders(withoutPathAndDescendants(excluded, folder)));
      return;
    }
    if (selected.includes(folder)) {
      onScanFoldersChange(serializeFolders(withoutPathAndDescendants(selected, folder)));
      return;
    }
    if (pathMatchesScope(folder, selected)) {
      onScanExcludeFoldersChange(serializeFolders([...excluded, folder]));
      return;
    }
    onScanFoldersChange(serializeFolders([...withoutPathAndDescendants(selected, folder), folder]));
  };

  const toggleExcludedFolder = (folder: string) => {
    if (excluded.includes(folder)) {
      onScanExcludeFoldersChange(serializeFolders(withoutPathAndDescendants(excluded, folder)));
      return;
    }
    onScanExcludeFoldersChange(serializeFolders([...withoutPathAndDescendants(excluded, folder), folder]));
  };

  const selectVisibleFolders = () => {
    onScanFoldersChange(serializeFolders([...selected, ...visibleFolders]));
  };

  const saveProfile = () => {
    const name = profileName.trim() || t("settings.sources.defaultProfileName", { count: profiles.length + 1 });
    const nextProfile: ScanProfile = {
      id: createProfileId(),
      name,
      scanMode: mode,
      scanFolders,
      scanExcludeFolders,
    };
    const nextProfiles = [...profiles.filter((profile) => profile.name.toLowerCase() !== name.toLowerCase()), nextProfile];
    onScanProfilesChange(serializeProfiles(nextProfiles));
    setProfileName("");
  };

  const loadProfile = (profile: ScanProfile) => {
    onScanScopeChange({
      scanMode: profile.scanMode,
      scanFolders: profile.scanFolders,
      scanExcludeFolders: profile.scanExcludeFolders,
    });
  };

  const deleteProfile = (id: string) => {
    onScanProfilesChange(serializeProfiles(profiles.filter((profile) => profile.id !== id)));
  };

  const summary = (() => {
    if (allSubfolders.length === 0) return t("settings.sources.summaryNoneDetected", { path: mediaDir });
    if (mode === "recursive") {
      return excluded.length > 0
        ? t("settings.sources.summaryRecursiveWithExclusions", { count: allSubfolders.length, excluded: excluded.length })
        : t("settings.sources.summaryRecursive", { count: allSubfolders.length });
    }
    if (mode === "root_only") return t("settings.sources.summaryRootOnly", { path: mediaDir });
    if (selected.length === 0) return t("settings.sources.summaryNoneSelected");
    return t("settings.sources.summaryCustom", { selected: selected.length, excluded: excluded.length, total: allSubfolders.length });
  })();

  const scanModeOptions = [
    { value: "recursive", label: t("settings.sources.scanRecursive"), desc: t("settings.sources.scanRecursiveDesc") },
    { value: "root_only", label: t("settings.sources.scanRootOnly"), desc: t("settings.sources.scanRootOnlyDesc") },
    { value: "selected", label: t("settings.sources.scanSelected"), desc: t("settings.sources.scanSelectedDesc") },
  ];

  return (
    <div className="space-y-5">
      <p className="text-[12px] text-[var(--text-2)]">{t("settings.sources.mediaSourcesIntro")}</p>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="text-[13px] font-medium text-[var(--text)]">{t("settings.sources.scanProfiles")}</div>
            <p className="text-[10.5px] text-[var(--text-3)]">{t("settings.sources.scanProfilesHint")}</p>
          </div>
          <div className="flex min-w-0 gap-2">
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder={t("settings.sources.profileNamePlaceholder")}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <button type="button" onClick={saveProfile} className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white">
              {t("settings.sources.saveScanProfile")}
            </button>
          </div>
        </div>
        {profiles.length === 0 ? (
          <p className="text-[10.5px] text-[var(--text-3)]">{t("settings.sources.noScanProfiles")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {profiles.map((profile) => (
              <div key={profile.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-[5px]">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-[var(--text)]">{profile.name}</div>
                  <div className="text-[10px] text-[var(--text-3)]">{t(`settings.sources.profileMode.${profile.scanMode}`)}</div>
                </div>
                <button type="button" onClick={() => loadProfile(profile)} className="rounded-md border border-[var(--border)] bg-[var(--surface-3)] px-2 py-1 text-[10px] text-[var(--text-2)] hover:text-[var(--text)]">
                  {t("settings.sources.loadScanProfile")}
                </button>
                <button type="button" onClick={() => deleteProfile(profile.id)} className="rounded-md px-2 py-1 text-[10px] text-[var(--text-3)] hover:text-[var(--red)]">
                  {t("common.delete")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--text)]">{t("settings.sources.detectedSources")}</div>
            <div className="text-[10.5px] text-[var(--text-3)]">
              {loading
                ? t("settings.sources.loadingSources")
                : t("settings.sources.detectedCount", { count: allSubfolders.length })}
              <span className="ml-2 font-mono text-[var(--text-3)]">{mediaDir}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={fetchSources}
            disabled={loading}
            className="shrink-0 text-[11px] text-[var(--accent)] hover:brightness-110 disabled:text-[var(--text-3)]"
          >
            {loading ? t("common.loading") : t("settings.sources.refreshFolders")}
          </button>
        </div>

        {error && <p className="mb-2 text-[11px] text-[var(--red)]">{error}</p>}

        <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center">
          <input
            value={folderSearch}
            onChange={(e) => setFolderSearch(e.target.value)}
            placeholder={t("settings.sources.folderSearchPlaceholder")}
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          {mode === "selected" && allSubfolders.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={selectVisibleFolders} className="rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-3 py-1.5 text-[11px] text-[var(--text-2)] hover:text-[var(--text)]">
                {t("settings.sources.selectVisibleFolders")}
              </button>
              <button type="button" onClick={() => onScanFoldersChange("")} className="rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-3 py-1.5 text-[11px] text-[var(--text-2)] hover:text-[var(--text)]">
                {t("settings.sources.clearSelectedFolders")}
              </button>
              {excluded.length > 0 && (
                <button type="button" onClick={() => onScanExcludeFoldersChange("")} className="rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-3 py-1.5 text-[11px] text-[var(--text-2)] hover:text-[var(--text)]">
                  {t("settings.sources.clearExcludedFolders")}
                </button>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <p className="text-[11px] text-[var(--text-3)]">{t("settings.sources.loadingSources")}</p>
        ) : allSubfolders.length === 0 ? (
          <p className="text-[11px] text-[var(--text-3)]">{t("settings.sources.summaryNoneDetected", { path: mediaDir })}</p>
        ) : visibleTree.length === 0 ? (
          <p className="text-[11px] text-[var(--text-3)]">{t("settings.sources.noFoldersMatch")}</p>
        ) : (
          <div className={`${isMobile ? "max-h-80" : "max-h-96"} overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5`}>
            <FolderTree
              nodes={visibleTree}
              mediaDir={mediaDir}
              mode={mode}
              selected={selected}
              excluded={excluded}
              expandedFolders={expandedFolders}
              setExpandedFolders={setExpandedFolders}
              searchActive={folderSearch.trim().length > 0}
              onToggleIncluded={toggleIncludedFolder}
              onToggleExcluded={toggleExcludedFolder}
              tasks={tasks}
              rules={rules}
              upsertRule={upsertRule}
              removeRuleForPath={removeRuleForPath}
            />
          </div>
        )}
      </div>

      <div>
        <label className="mb-2 block text-[12px] font-medium text-[var(--text-2)]">{t("settings.sources.scanMode")}</label>
        <div>
          {scanModeOptions.map((opt) => (
            <label
              key={opt.value}
              className={`mb-[6px] flex cursor-pointer items-start gap-2.5 rounded-lg border p-[9px_11px] transition-colors ${mode === opt.value ? "border-[var(--accent-border)] bg-[var(--accent-dim)]" : "border-[var(--border)] bg-[var(--surface-2)]"}`}
            >
              <input
                type="radio"
                name="scan_mode"
                value={opt.value}
                checked={mode === opt.value}
                onChange={(e) => onScanModeChange(e.target.value)}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <div>
                <div className="text-[13px] text-[var(--text)]">{opt.label}</div>
                <p className="text-[10px] text-[var(--text-3)]">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-[10px_12px]">
        <div className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">{t("settings.sources.scanSummary")}</div>
        <div className="mt-1 text-[13px] text-[var(--text-2)]">{summary}</div>
      </div>

      <DirectoryRulesSection
        folders={allSubfolders}
        rawRules={directoryRules}
        onChange={onDirectoryRulesChange}
        tasks={tasks}
      />

      <details className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <summary className="cursor-pointer text-[11px] text-[var(--text-2)] hover:text-[var(--text)]">
          {t("settings.sources.helpTitle")}
        </summary>
        <p className="mt-2 whitespace-pre-line text-[11px] leading-relaxed text-[var(--text-3)]">
          {t("settings.sources.helpBody", { path: mediaDir })}
        </p>
      </details>
    </div>
  );
}

interface FolderTreeSharedProps {
  tasks: Task[];
  rules: DirectoryRule[];
  upsertRule: (path: string, patch: Partial<Pick<DirectoryRule, "translateWithoutVideo" | "taskIds">>) => void;
  removeRuleForPath: (path: string) => void;
}

function FolderTree({
  nodes,
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
}: {
  nodes: FolderNode[];
  mediaDir: string;
  mode: ScanMode;
  selected: string[];
  excluded: string[];
  expandedFolders: Set<string>;
  setExpandedFolders: Dispatch<SetStateAction<Set<string>>>;
  searchActive: boolean;
  onToggleIncluded: (folder: string) => void;
  onToggleExcluded: (folder: string) => void;
} & FolderTreeSharedProps) {
  return (
    <div className="space-y-1">
      {nodes.map((node) => (
        <FolderTreeRow
          key={node.path}
          node={node}
          depth={0}
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
              className={`px-2.5 py-1 text-[11px] ${currentTwv === state ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)]"}`}
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
}: {
  node: FolderNode;
  depth: number;
  mediaDir: string;
  mode: ScanMode;
  selected: string[];
  excluded: string[];
  expandedFolders: Set<string>;
  setExpandedFolders: Dispatch<SetStateAction<Set<string>>>;
  searchActive: boolean;
  onToggleIncluded: (folder: string) => void;
  onToggleExcluded: (folder: string) => void;
} & FolderTreeSharedProps) {
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

function DirectoryRulesSection({
  folders,
  rawRules,
  onChange,
  tasks,
}: {
  folders: string[];
  rawRules: string;
  onChange: (rules: string) => void;
  tasks: Task[];
}) {
  const { t } = useTranslation();

  const rules = useMemo(() => parseDirectoryRules(rawRules), [rawRules]);

  const commit = (next: DirectoryRule[]) => onChange(serializeDirectoryRules(next));

  const addRule = () => {
    // Pick the first folder (incl. root "") that doesn't already have a rule, so
    // clicking Add twice can't create two rules for the same path.
    const taken = new Set(rules.map((r) => r.path));
    const path = ["", ...folders].find((p) => !taken.has(p));
    if (path === undefined) return;
    commit([
      ...rules,
      { id: createRuleId(), path, enabled: true, translateWithoutVideo: "on", taskIds: [] },
    ]);
  };

  const updateRule = (id: string, patch: Partial<DirectoryRule>) => {
    commit(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRule = (id: string) => commit(rules.filter((r) => r.id !== id));

  const toggleTask = (rule: DirectoryRule, taskId: number) => {
    const taskIds = rule.taskIds.includes(taskId)
      ? rule.taskIds.filter((n) => n !== taskId)
      : [...rule.taskIds, taskId];
    updateRule(rule.id, { taskIds });
  };

  const triLabel = (state: TriState): string => t(`settings.sources.dirRules.tri_${state}`);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--text)]">{t("settings.sources.dirRules.title")}</div>
          <p className="text-[10.5px] text-[var(--text-3)]">{t("settings.sources.dirRules.hint")}</p>
        </div>
        <button type="button" onClick={addRule} className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white">
          {t("settings.sources.dirRules.addRule")}
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="text-[10.5px] text-[var(--text-3)]">{t("settings.sources.dirRules.noRules")}</p>
      ) : (
        <div className="space-y-2.5">
          {rules.map((rule) => (
            <div key={rule.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  {t("settings.sources.dirRules.enabled")}
                </label>
                <select
                  value={rule.path}
                  onChange={(e) => updateRule(rule.id, { path: e.target.value })}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                >
                  <option value="">{t("settings.sources.dirRules.allFolders")}</option>
                  {folders.map((folder) => (
                    <option key={folder} value={folder}>{folder}</option>
                  ))}
                </select>
                <button type="button" onClick={() => removeRule(rule.id)} className="rounded-md px-2 py-1 text-[10px] text-[var(--text-3)] hover:text-[var(--red)]">
                  {t("common.delete")}
                </button>
              </div>

              <div className="mb-2">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-3)]">{t("settings.sources.dirRules.videolessLabel")}</div>
                <div className="inline-flex overflow-hidden rounded-lg border border-[var(--border)]">
                  {TRI_STATES.map((state) => (
                    <button
                      key={state}
                      type="button"
                      onClick={() => updateRule(rule.id, { translateWithoutVideo: state })}
                      className={`px-2.5 py-1 text-[11px] ${rule.translateWithoutVideo === state ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)]"}`}
                    >
                      {triLabel(state)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-3)]">{t("settings.sources.dirRules.languagesLabel")}</div>
                {tasks.length === 0 ? (
                  <p className="text-[10.5px] text-[var(--text-3)]">{t("settings.sources.dirRules.noTasks")}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {tasks.map((task) => (
                      <label
                        key={task.id}
                        className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${rule.taskIds.includes(task.id) ? "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)]"}`}
                      >
                        <input
                          type="checkbox"
                          checked={rule.taskIds.includes(task.id)}
                          onChange={() => toggleTask(rule, task.id)}
                          className="h-3 w-3 accent-[var(--accent)]"
                        />
                        {task.target_lang}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
