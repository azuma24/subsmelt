import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import type { FolderNode, Task } from "../../types";
import { DirectoryRulesSection } from "./media-sources/DirectoryRulesSection";
import { FolderTree, toSettingsTree } from "./media-sources/FolderTree";
import { ScanProfilesSection } from "./media-sources/ScanProfilesSection";
import { usePersistedExpansion, type TreeExpansion } from "../../components/file-tree/use-persisted-expansion";
import { useDrillDown } from "../../components/file-tree/use-drill-down";
import {
  SCAN_MODES,
  collectNodePaths,
  createProfileId,
  createRuleId,
  filterTree,
  flattenFolderTree,
  parseDirectoryRules,
  parseFolders,
  parseProfiles,
  pathMatchesScope,
  serializeDirectoryRules,
  serializeFolders,
  serializeProfiles,
  withoutPathAndDescendants,
  type DirectoryRule,
  type ScanMode,
  type ScanProfile,
} from "./media-sources/model";

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

/**
 * Sources → Media sources.
 *
 * The folder tree is the primary control and stays inline; the two secondary
 * editors (saved scan profiles, per-directory rules) are behind their own
 * accordions, and the tree/rules rendering plus the parse/serialize model live
 * in `./media-sources/`. Every writer prop is passed straight through unchanged
 * — this panel does not decide when settings are saved.
 */
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);

  const fetchSources = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFolderTree();
      setFolderRoot(data.root);
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

  // Expand/collapse is persisted per folder in localStorage (default
  // collapsed), pruned against the full unfiltered tree so a narrower search
  // can't silently discard state. While searching, every visible folder is
  // forced open instead so matches aren't hidden behind a collapsed parent.
  const searchActive = folderSearch.trim().length > 0;
  const persistedExpansion = usePersistedExpansion("mediaSources", allSubfolders);
  const expansion: TreeExpansion = searchActive
    ? { expanded: new Set(visibleFolders), toggleExpand: persistedExpansion.toggleExpand }
    : persistedExpansion;
  const adaptedRoots = useMemo(() => toSettingsTree(visibleTree), [visibleTree]);
  const drill = useDrillDown(adaptedRoots, isMobile && !searchActive);

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

  const saveProfile = (rawName: string) => {
    const name = rawName.trim() || t("settings.sources.defaultProfileName", { count: profiles.length + 1 });
    const nextProfile: ScanProfile = {
      id: createProfileId(),
      name,
      scanMode: mode,
      scanFolders,
      scanExcludeFolders,
    };
    const nextProfiles = [...profiles.filter((profile) => profile.name.toLowerCase() !== name.toLowerCase()), nextProfile];
    onScanProfilesChange(serializeProfiles(nextProfiles));
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
            aria-label={t("settings.sources.folderSearchPlaceholder")}
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
              nodes={adaptedRoots}
              mediaDir={mediaDir}
              mode={mode}
              selected={selected}
              excluded={excluded}
              isMobile={isMobile}
              expansion={expansion}
              drill={drill}
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

      <ScanProfilesSection
        profiles={profiles}
        onSave={saveProfile}
        onLoad={loadProfile}
        onDelete={deleteProfile}
      />

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
