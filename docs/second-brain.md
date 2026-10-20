# Second-brain selection

SubSmelt writes one Markdown note per finished YouTube video into the notes
folder (`youtube_notes_dir`, `/notes` by default), inside a folder named after
the playlist's folder. It does this for **every** followed playlist and
channel. The second-brain choice does not change that.

The choice decides which of those note folders a separate, read-only mirror
(for example a Mac-side copy that a QMD collection indexes) may pick up. That
mirror is not part of SubSmelt and is not running yet. SubSmelt does not copy,
index or delete anything because of this setting.

## Choosing playlists

Open **Follow** or **Edit** on a playlist and tick **Send notes to my second
brain**. Selected playlists show a **Second brain** tag in the list and on
their page.

- New follows start unselected.
- Playlists followed before this setting existed read as unselected.
- Unticking a playlist deletes nothing: notes already written stay in the
  notes folder, and files a mirror already copied stay wherever it put them.
  Removing them from the mirror or its index is a separate, deliberate step.

The value is stored on the playlist as `secondBrainExport` (`true` or
`false`). `POST /api/youtube/playlists` and `PUT /api/youtube/playlists/:id`
accept it, reject anything that is not a boolean, and an edit that leaves it
out keeps the current value. `GET /api/youtube/playlists` returns it.

## The allowlist

`GET /api/youtube/second-brain` returns:

```json
{
  "folders": ["Music", "Talks/AI agents"],
  "withheld": [{ "id": "PL…", "title": "AI" }]
}
```

- `folders` are paths **relative to the notes folder**, spelled the way the
  note writer names them (the playlist folder with characters Obsidian or the
  filesystem refuses replaced). The response never contains a host path.
- A mirror must copy only these folders, and must treat a folder missing from
  the list as not allowed, even if it allowed it before.
- `withheld` lists selected playlists whose note folder is **not** in
  `folders`, because copying it would also copy notes of a playlist that is
  not selected:
  - an unselected playlist uses the same note folder (compared without
    regard to case, as on macOS and Windows), or
  - an unselected playlist's note folder is nested inside it, or
  - the folder resolves to the notes folder itself.

  Give the playlists separate folders (Edit → More → Folder) to release it.

## Videos in more than one playlist

A video has one row and one note. The note lives in the folder of the playlist
that owns the row when the note is written. Before download, a video can still
move to another followed playlist that wants it (for example one that queues
it where its owner skipped it). Once downloaded, it stays with its owner.
Eligibility follows that owner: a video owned by an unselected playlist is not
mirrored even if a selected playlist also lists it.

## Known limits

- Notes of a playlist that has since been unfollowed keep their old folder.
  They are not on the allowlist unless a selected playlist uses that same
  folder name.
- Changing a playlist's folder moves a note only when the note is written
  again. Until then, older notes stay in the old folder.
- The allowlist describes folders, not files. A mirror that copies a listed
  folder copies whatever is in it, including files put there by hand.
