import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type { FolderNode } from "../../types";

type ScanMode = "recursive" | "root_only" | "selected";

interface MediaSourcesPanelProps {
  isMobile: boolean;
  mediaDir: string;
  scanMode: string;
  scanFolders: string;
  scanExcludeFolders: string;
  scanProfiles: string;
  onScanModeChange: (mode: string) => void;
  onScanFoldersChange: (folders: string) => void;
  onScanExcludeFoldersChange: (folders: string) => void;
  onScanScopeChange: (scope: { scanMode: string; scanFolders: string; scanExcludeFolders: string }) => void;
  onScanProfilesChange: (profiles: string) => void;
}

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
  onScanModeChange,
  onScanFoldersChange,
  onScanExcludeFoldersChange,
  onScanScopeChange,
  onScanProfilesChange,
}: MediaSourcesPanelProps) {
  const { t } = useTranslation();
  const [folderRoot, setFolderRoot] = useState<FolderNode | null>(null);
  const [folderSearch, setFolderSearch] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [profileName, setProfileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <p className="text-sm text-gray-400">{t("settings.sources.mediaSourcesIntro")}</p>

      <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
        <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="text-sm font-medium text-gray-200">{t("settings.sources.scanProfiles")}</div>
            <p className="text-[11px] text-gray-500">{t("settings.sources.scanProfilesHint")}</p>
          </div>
          <div className="flex min-w-0 gap-2">
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder={t("settings.sources.profileNamePlaceholder")}
              className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-200"
            />
            <button type="button" onClick={saveProfile} className="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white">
              {t("settings.sources.saveScanProfile")}
            </button>
          </div>
        </div>
        {profiles.length === 0 ? (
          <p className="text-[11px] text-gray-600">{t("settings.sources.noScanProfiles")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {profiles.map((profile) => (
              <div key={profile.id} className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-gray-200">{profile.name}</div>
                  <div className="text-[10px] text-gray-500">{t(`settings.sources.profileMode.${profile.scanMode}`)}</div>
                </div>
                <button type="button" onClick={() => loadProfile(profile)} className="rounded-md bg-gray-800 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-700">
                  {t("settings.sources.loadScanProfile")}
                </button>
                <button type="button" onClick={() => deleteProfile(profile.id)} className="rounded-md px-2 py-1 text-[10px] text-gray-500 hover:text-red-300">
                  {t("common.delete")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-200">{t("settings.sources.detectedSources")}</div>
            <div className="text-[11px] text-gray-500">
              {loading
                ? t("settings.sources.loadingSources")
                : t("settings.sources.detectedCount", { count: allSubfolders.length })}
              <span className="ml-2 font-mono text-gray-600">{mediaDir}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={fetchSources}
            disabled={loading}
            className="shrink-0 text-[11px] text-blue-400 hover:text-blue-300 disabled:text-gray-600"
          >
            {loading ? t("common.loading") : t("settings.sources.refreshFolders")}
          </button>
        </div>

        {error && <p className="mb-2 text-[11px] text-red-400">{error}</p>}

        <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center">
          <input
            value={folderSearch}
            onChange={(e) => setFolderSearch(e.target.value)}
            placeholder={t("settings.sources.folderSearchPlaceholder")}
            className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-200"
          />
          {mode === "selected" && allSubfolders.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={selectVisibleFolders} className="rounded-lg bg-gray-800 px-3 py-2 text-[11px] text-gray-300 hover:bg-gray-700">
                {t("settings.sources.selectVisibleFolders")}
              </button>
              <button type="button" onClick={() => onScanFoldersChange("")} className="rounded-lg bg-gray-800 px-3 py-2 text-[11px] text-gray-400 hover:bg-gray-700">
                {t("settings.sources.clearSelectedFolders")}
              </button>
              {excluded.length > 0 && (
                <button type="button" onClick={() => onScanExcludeFoldersChange("")} className="rounded-lg bg-gray-800 px-3 py-2 text-[11px] text-gray-400 hover:bg-gray-700">
                  {t("settings.sources.clearExcludedFolders")}
                </button>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <p className="text-[11px] text-gray-500">{t("settings.sources.loadingSources")}</p>
        ) : allSubfolders.length === 0 ? (
          <p className="text-[11px] text-gray-500">{t("settings.sources.summaryNoneDetected", { path: mediaDir })}</p>
        ) : visibleTree.length === 0 ? (
          <p className="text-[11px] text-gray-500">{t("settings.sources.noFoldersMatch")}</p>
        ) : (
          <div className={`${isMobile ? "max-h-80" : "max-h-96"} overflow-y-auto rounded-xl border border-gray-800 bg-gray-950/50 p-2`}>
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
            />
          </div>
        )}
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-300">{t("settings.sources.scanMode")}</label>
        <div className="space-y-2">
          {scanModeOptions.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-3 rounded-2xl border border-gray-800 bg-gray-950/40 p-3"
            >
              <input
                type="radio"
                name="scan_mode"
                value={opt.value}
                checked={mode === opt.value}
                onChange={(e) => onScanModeChange(e.target.value)}
                className="mt-1 accent-blue-500"
              />
              <div>
                <div className="text-sm text-gray-200">{opt.label}</div>
                <p className="text-[10px] text-gray-500">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-3">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">{t("settings.sources.scanSummary")}</div>
        <div className="mt-1 text-sm text-gray-200">{summary}</div>
      </div>

      <details className="rounded-2xl border border-gray-800 bg-gray-950/40 p-3">
        <summary className="cursor-pointer text-[11px] text-gray-400 hover:text-gray-300">
          {t("settings.sources.helpTitle")}
        </summary>
        <p className="mt-2 whitespace-pre-line text-[11px] leading-relaxed text-gray-500">
          {t("settings.sources.helpBody", { path: mediaDir })}
        </p>
      </details>
    </div>
  );
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
}) {
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
        />
      ))}
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
}) {
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

  const toggleExpanded = () => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  return (
    <div>
      <div
        className={`flex items-center gap-2 rounded-lg border px-2 py-2 transition-colors ${
          excludedHere
            ? "border-red-900/50 bg-red-950/20"
            : checked
              ? "border-blue-900/50 bg-blue-950/20"
              : "border-gray-800 bg-gray-900/30"
        }`}
        style={{ paddingLeft: `${8 + depth * 18}px` }}
      >
        <button
          type="button"
          onClick={toggleExpanded}
          disabled={!hasChildren}
          className="h-6 w-6 shrink-0 rounded-md text-xs text-gray-500 hover:bg-gray-800 disabled:opacity-20"
          aria-label={expanded ? t("settings.sources.collapseFolder") : t("settings.sources.expandFolder")}
        >
          {hasChildren ? (expanded ? "v" : ">") : ""}
        </button>
        {interactive && (
          <input
            type="checkbox"
            checked={checked}
            ref={(el) => {
              if (el) el.indeterminate = mixed;
            }}
            onChange={() => onToggleIncluded(node.path)}
            className="h-4 w-4 shrink-0 accent-blue-500"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-gray-200">{node.name}</div>
          <div className="truncate font-mono text-[10px] text-gray-500">{mediaDir}/{node.path}</div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[9px] text-gray-500">
            <span className="rounded-full bg-gray-800 px-2 py-0.5">{t("settings.sources.folderCountVideos", { count: node.counts.videos })}</span>
            <span className="rounded-full bg-gray-800 px-2 py-0.5">{t("settings.sources.folderCountSubtitles", { count: node.counts.subtitles })}</span>
            {node.counts.pendingJobs > 0 && <span className="rounded-full bg-yellow-900/20 px-2 py-0.5 text-yellow-300">{t("settings.sources.folderCountPending", { count: node.counts.pendingJobs })}</span>}
            {node.counts.completeJobs > 0 && <span className="rounded-full bg-green-900/20 px-2 py-0.5 text-green-300">{t("settings.sources.folderCountComplete", { count: node.counts.completeJobs })}</span>}
            {node.counts.errorJobs > 0 && <span className="rounded-full bg-red-900/20 px-2 py-0.5 text-red-300">{t("settings.sources.folderCountErrors", { count: node.counts.errorJobs })}</span>}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium ${
          excludedHere ? "bg-red-900/40 text-red-300" : checked ? "bg-blue-900/40 text-blue-300" : "bg-gray-800 text-gray-500"
        }`}>
          {excludedHere ? t("settings.sources.excludedBadge") : checked ? t("settings.sources.includedBadge") : t("settings.sources.notIncludedBadge")}
        </span>
        {interactive && (checked || excludedHere) && (
          <button
            type="button"
            onClick={() => onToggleExcluded(node.path)}
            className={`rounded-lg px-2 py-1 text-[10px] font-medium ${
              excludedHere ? "bg-gray-800 text-gray-300 hover:bg-gray-700" : "bg-red-950/50 text-red-300 hover:bg-red-900/50"
            }`}
          >
            {excludedHere ? t("settings.sources.allowFolder") : t("settings.sources.excludeFolder")}
          </button>
        )}
      </div>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}
