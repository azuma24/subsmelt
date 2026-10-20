import type { YoutubeSecondBrain } from "../../shared/youtube.js";
import { noteFolderSegments } from "./note.js";
import type { YoutubePlaylist } from "./playlists.js";

// Compared the way a case-insensitive filesystem (macOS, Windows) would, so "AI" and "ai" are one folder.
const folderKey = (folder: string) => folder.normalize("NFC").toLowerCase();
const within = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`);

/**
 * The note folders a second-brain mirror may copy: those of playlists with
 * secondBrainExport on, relative to the notes folder. A video in several
 * playlists has one note, in the folder of the playlist that owns its row, so
 * eligibility follows that owner. A selected folder that would also carry an
 * unselected playlist's notes (same folder, or one nested inside it) is withheld.
 */
export function secondBrainFolders(playlists: readonly YoutubePlaylist[]): YoutubeSecondBrain {
  const unselected = playlists
    .filter((p) => !p.secondBrainExport)
    .map((p) => folderKey(noteFolderSegments(p.folder).join("/")));
  const folders = new Map<string, string>();
  const withheld: YoutubeSecondBrain["withheld"] = [];
  for (const playlist of playlists) {
    if (!playlist.secondBrainExport) continue;
    const folder = noteFolderSegments(playlist.folder).join("/");
    const key = folderKey(folder);
    // An empty folder is the notes folder itself, which holds every playlist's notes.
    if (!folder || unselected.some((other) => within(other, key))) {
      withheld.push({ id: playlist.id, title: playlist.title });
      continue;
    }
    if (!folders.has(key)) folders.set(key, folder);
  }
  return { folders: [...folders.values()].sort(), withheld };
}
