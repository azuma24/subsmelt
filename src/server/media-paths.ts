import path from "node:path";

/** Directory-relative (POSIX-separated) path of ``filePath`` under ``mediaRoot``,
 *  or ``null`` when the file lives outside the media root. A file directly in
 *  the root yields ``""``. */
export function mediaRelativeDir(filePath: string, mediaRoot: string): string | null {
  const root = path.resolve(mediaRoot);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  const relativeDir = path.relative(root, path.dirname(resolved)).split(path.sep).join("/");
  return relativeDir === "." ? "" : relativeDir;
}

/** Normalize a user-supplied media subfolder to a POSIX relative path, or ``null``
 *  when it is unsafe: empty, absolute, contains a NUL, or escapes the root via
 *  ``..``. Backslashes are folded to forward slashes. */
export function normalizeMediaSubfolder(folder: string): string | null {
  const trimmed = folder.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.includes("\0") || trimmed.startsWith("/")) return null;

  const normalized = path.posix.normalize(trimmed);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

/** Resolve a user-supplied media subfolder to an absolute path under ``mediaRoot``,
 *  or ``null`` when it is unsafe / escapes the root. */
export function resolveMediaSubfolder(folder: string, mediaRoot: string): string | null {
  const normalized = normalizeMediaSubfolder(folder);
  if (!normalized) return null;

  const root = path.resolve(mediaRoot);
  const fullPath = path.resolve(root, ...normalized.split("/"));
  if (fullPath === root || !fullPath.startsWith(`${root}${path.sep}`)) return null;
  return path.join(mediaRoot, ...normalized.split("/"));
}
