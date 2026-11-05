/**
 * Whether a row's folder is in the selected folder. Rows carry their folder as
 * a media-relative label ("UniFi/Tutorials"), or a stand-in label for the media
 * root and for files outside it. A real folder takes its subfolders with it,
 * so picking "UniFi" in the folder sidebar shows UniFi/Tutorials too; a
 * stand-in label matches only itself.
 */
export function folderInScope(label: string, filter: string, ...standIns: string[]): boolean {
  if (filter === "all" || label === filter) return true;
  if (standIns.includes(filter)) return false;
  return label.startsWith(`${filter}/`);
}

/** "UniFi/Tutorials/2024" → ["UniFi", "UniFi/Tutorials", "UniFi/Tutorials/2024"], for a breadcrumb. */
export function folderTrail(folder: string): string[] {
  const parts = folder.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
