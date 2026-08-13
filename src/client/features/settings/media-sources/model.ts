import type { FolderNode } from "../../../types";

/**
 * Pure data model behind the Sources → Media sources editor.
 *
 * These types and helpers were file-local to a 941-line `MediaSourcesPanel.tsx`.
 * Splitting them out is behaviour-preserving: every function below is copied
 * verbatim, so the on-the-wire shapes of `scan_profiles` and `directory_rules`
 * are unchanged.
 */

export type ScanMode = "recursive" | "root_only" | "selected";
export type TriState = "inherit" | "on" | "off";

export interface DirectoryRule {
  id: string;
  path: string;
  enabled: boolean;
  translateWithoutVideo: TriState;
  taskIds: number[];
}

export interface ScanProfile {
  id: string;
  name: string;
  scanMode: ScanMode;
  scanFolders: string;
  scanExcludeFolders: string;
}

export const TRI_STATES: TriState[] = ["inherit", "on", "off"];
export const SCAN_MODES: ScanMode[] = ["recursive", "root_only", "selected"];

export const createRuleId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const createProfileId = createRuleId;

export const parseDirectoryRules = (raw: string): DirectoryRule[] => {
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

export const serializeDirectoryRules = (rules: DirectoryRule[]): string => JSON.stringify(rules);

export const parseFolders = (raw: string): string[] =>
  raw.split(",").map((f) => f.trim()).filter(Boolean);

export const serializeFolders = (folders: string[]): string =>
  Array.from(new Set(folders)).filter(Boolean).join(",");

export const parseProfiles = (raw: string): ScanProfile[] => {
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

export const serializeProfiles = (profiles: ScanProfile[]): string =>
  JSON.stringify(profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    scanMode: profile.scanMode,
    scanFolders: profile.scanFolders,
    scanExcludeFolders: profile.scanExcludeFolders,
  })));

export function flattenFolderTree(nodes: FolderNode[], results: string[] = []): string[] {
  nodes.forEach((node) => {
    results.push(node.path);
    flattenFolderTree(node.children, results);
  });
  return results;
}

export function collectNodePaths(nodes: FolderNode[], results: string[] = []): string[] {
  nodes.forEach((node) => {
    results.push(node.path);
    collectNodePaths(node.children, results);
  });
  return results;
}

export function filterTree(nodes: FolderNode[], query: string): FolderNode[] {
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

export function pathMatchesScope(path: string, folders: string[]): boolean {
  return folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

export function hasDescendant(path: string, folders: string[]): boolean {
  return folders.some((folder) => folder.startsWith(`${path}/`));
}

export function withoutPathAndDescendants(folders: string[], path: string): string[] {
  return folders.filter((folder) => folder !== path && !folder.startsWith(`${path}/`));
}
