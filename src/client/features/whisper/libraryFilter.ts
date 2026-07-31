import type { ScannedFile } from "../../types";

/**
 * Filtering for the Whisper library tree.
 *
 * The tree lists every video in the media root — 159 of them in the reported
 * case — with no way to narrow it, so finding one file meant scrolling. Matching
 * runs against the full path, not just the file name, so a folder name is a
 * usable query too.
 */

export interface LibraryFilter {
  /** Free-text query; whitespace-only is treated as no filter. */
  query?: string;
  /** Hide files that already have at least one subtitle. */
  hideWithSubtitles?: boolean;
}

function matchesQuery(file: ScannedFile, needle: string): boolean {
  const haystack = `${file.videoPath ?? ""} ${file.videoName ?? ""}`.toLowerCase();
  // Every whitespace-separated term must appear, so "deep stream" narrows rather
  // than widening the way a single substring match would.
  return needle.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

export function hasSubtitles(file: ScannedFile): boolean {
  return file.subtitles.length > 0;
}

export function filterLibraryFiles(files: ScannedFile[], filter: LibraryFilter = {}): ScannedFile[] {
  const needle = (filter.query ?? "").trim().toLowerCase();
  if (!needle && !filter.hideWithSubtitles) return files;

  return files.filter((file) => {
    if (filter.hideWithSubtitles && hasSubtitles(file)) return false;
    if (needle && !matchesQuery(file, needle)) return false;
    return true;
  });
}
