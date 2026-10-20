# Knowledge-base selection

SubSmelt writes one Markdown note per finished YouTube video into the notes
folder (`youtube_notes_dir`, `/notes` by default), inside a folder named after
the playlist's folder. It does this for **every** followed playlist and
channel. The knowledge-base choice does not change that.

The choice decides which of those notes a separate, read-only mirror (for
example a Mac-side copy that a QMD collection indexes) may pick up. That
mirror is not part of SubSmelt. SubSmelt does not copy, index or delete
anything because of this setting.

## Choosing playlists

Open **Follow** or **Edit** on a playlist and tick **Enable for knowledge base**.
Selected playlists show a **Selected for knowledge base** tag in the list and
on their page. This is a future-sync selection, not a running sync.

- New follows start unselected.
- Playlists followed before this setting existed read as unselected.
- Unticking a playlist deletes nothing: notes already written stay in the
  notes folder, and files a mirror already copied stay wherever it put them.
  Removing them from the mirror or its index is a separate, deliberate step.

The value is stored on the playlist as `secondBrainExport` (`true` or
`false`). `POST /api/youtube/playlists` and `PUT /api/youtube/playlists/:id`
accept it, reject anything that is not a boolean, and an edit that leaves it
out keeps the current value. `GET /api/youtube/playlists` returns it.

## Browse exported notes

Open **YouTube → Notes** to browse, read, and search generated Markdown notes
from followed playlists. Search also matches note content. Filter by playlist,
saved notes, or blocked note exports; select a result to read it in SubSmelt.
The reader is read-only because a re-export can replace generated files.
Missing/unwritable notes folders and failed exports are shown as health issues,
not as translation in progress. This does not mirror notes to another device.

The read-only `GET /api/youtube/notes` and `GET /api/youtube/notes/:videoId`
endpoints only return notes belonging to followed playlists. A detail read
requires a file inside the configured notes root and rejects unsafe, missing,
or oversized files. The default `/notes` must be mounted writable in Docker.

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
- A mirror that copies whole folders must copy only these folders, and must
  treat a folder missing from the list as not allowed, even if it allowed it
  before.
- `withheld` lists selected playlists whose note folder is **not** in
  `folders`, because copying it would also copy notes of a playlist that is
  not selected:
  - an unselected playlist uses the same note folder (compared without
    regard to case, as on macOS and Windows), or
  - an unselected playlist's note folder is nested inside it, or
  - the folder resolves to the notes folder itself.

  Give the playlists separate folders (Edit → More → Folder) to release it.

A mirror that works note by note from the change feed below does not need
this endpoint: it selects by the owning playlist's id, so shared and nested
folders cannot widen what it copies.

## Videos in more than one playlist

A video has one row and one note. The note lives in the folder of the playlist
that owns the row when the note is written. Before download, a video can still
move to another followed playlist that wants it (for example one that queues
it where its owner skipped it). Once downloaded, it stays with its owner,
unless the owner is unfollowed and another followed playlist lists the video:
then that playlist takes the row over, note included, and the change feed
reports the note under its new owner. Eligibility follows the owner: a video
owned by an unselected playlist is not mirrored even if a selected playlist
also lists it.

## Mirroring notes with the change feed

Since 0.7.1 a mirror no longer has to page through every note to learn what
changed. SubSmelt keeps an append-only **journal of note changes** in its
SQLite database and serves it as a cursor feed, together with a small
sync-state endpoint that says which playlists are selected and where the
feed stands.

### Which routes a mirror uses

| Need | Route | Cost per call |
|---|---|---|
| What changed since my cursor | `GET /api/youtube/notes/changes?after=&limit=` | One indexed query; no filesystem access, whatever the note count |
| Which playlists are selected, where the feed stands, is the notes folder there | `GET /api/youtube/notes/sync-state` | Reads the playlist setting and stats the notes folder once |
| The body of one note | `GET /api/youtube/notes/:videoId` (unchanged) | Reads that one file |
| Folder-level allowlist for whole-folder mirrors | `GET /api/youtube/second-brain` (unchanged) | Reads the playlist setting |
| Full listing for older clients, search, export health | `GET /api/youtube/notes` (unchanged) | Stats every candidate note |

No other route was added. The list route stays the fallback for clients
written against 0.7.0; its response did not change.

### Sync state

`GET /api/youtube/notes/sync-state`:

```json
{
  "generation": "3f9a1c2b7d4e6f80",
  "head": "3f9a1c2b7d4e6f80.1532",
  "selectionRevision": "a91c0d4e2b7f3a66",
  "selection": [
    { "playlistId": "PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "title": "Talks", "folder": "Talks" },
    { "playlistId": "UUxxxxxxxxxxxxxxxxxxxxxx", "title": "A channel", "folder": "A channel" }
  ],
  "notesRoot": { "exists": true, "writable": true }
}
```

- `selection` lists the followed playlists ticked for the knowledge base, by
  id, sorted by id, with the note folder each writes into relative to the
  notes folder. A playlist that is unticked or unfollowed is simply absent.
  Select notes by `playlistId`, never by folder name: folders can be shared
  or nested, and only the owning playlist decides.
- `selectionRevision` is a hash of `selection`. It changes exactly when the
  list changes, so a mirror compares one string per poll and diffs the list
  only on a change. Selection changes never add events to the feed.
- `generation` and `head` are the journal's current generation and newest
  cursor; see below.
- `notesRoot` says whether the folder is mounted and writable, without its
  path. A missing or unwritable root is a health problem, **not** a removal
  of any note: the feed emits nothing for existing notes while the root is
  away, and a mirror must not drop anything because of it.

### Change feed

`GET /api/youtube/notes/changes?after=<cursor>&limit=<1..100>`:

```json
{
  "generation": "3f9a1c2b7d4e6f80",
  "head": "3f9a1c2b7d4e6f80.1532",
  "changes": [
    {
      "sequence": 1531,
      "cursor": "3f9a1c2b7d4e6f80.1531",
      "kind": "upsert",
      "videoId": "iSn77jvjojA",
      "playlistId": "PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "notePath": "Talks/Short talk 2 (iSn77jvjojA).md",
      "previousNotePath": "Talks/Short talk (iSn77jvjojA).md",
      "title": "Short talk #2",
      "reason": null,
      "at": "2026-10-20T09:12:44.118Z"
    },
    {
      "sequence": 1532,
      "cursor": "3f9a1c2b7d4e6f80.1532",
      "kind": "unavailable",
      "videoId": "qN6OM1IzjIE",
      "playlistId": "PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "notePath": null,
      "previousNotePath": null,
      "title": "Teaching in the Age of AI",
      "reason": "notes_root_missing",
      "at": "2026-10-20T09:13:02.004Z"
    }
  ],
  "nextCursor": "3f9a1c2b7d4e6f80.1532",
  "hasMore": false
}
```

**Query.** `after` is a cursor the feed handed out, or omitted (or empty) to
start from the beginning of the journal. `limit` is 1 to 100 and defaults to
100. Any other query key is refused.

**Cursors.** A cursor is opaque text of the form `<generation>.<sequence>`:
16 hex characters, a dot, and a decimal sequence number. Treat it as a token:
store the `nextCursor` you were given and send it back unchanged. Sequence
numbers come from SQLite's `AUTOINCREMENT`, so they only ever grow and are
never reused. The generation is minted once when the journal is created and
stored beside it, so a cursor from one SubSmelt database is never accepted
by another.

**Paging.** Events come oldest first. Each page is read against the head
captured in the same transaction: events appended while you page always land
after the page and are never skipped, and `hasMore` is false only when the
page reached that head. `nextCursor` is the cursor of the last event on the
page (or your `after` when the page is empty), so a client may also
checkpoint at any event's own `cursor`. Replaying a cursor returns the same
events; `head` and `hasMore` describe the journal as it is now. When
`nextCursor` equals `head`, you are caught up.

**Event fields.**

| Field | Meaning |
|---|---|
| `sequence`, `cursor` | Position in the journal, as a number and as the cursor naming it |
| `kind` | `upsert`, `unavailable` or `remove`; see below |
| `videoId` | The video the note belongs to; a mirror keys its index by it |
| `playlistId` | The playlist that owned the row when the event was recorded |
| `notePath` | The note's path relative to the notes folder, with `/` separators; `null` when no file is known |
| `previousNotePath` | For a re-export under a new title, the relative path it replaced; otherwise `null` |
| `title` | The video title as the row had it |
| `reason` | For `unavailable`, why; otherwise `null` |
| `at` | When the event was recorded |

**Kinds.**

- `upsert`: the note at `notePath` was written, written again, or is served
  again. Fetch the body from `GET /api/youtube/notes/:videoId`; it replaces
  whatever you hold for that `videoId`, and if `previousNotePath` is set the
  file at that old path is gone. A detail request that returns 404 means the
  note cannot be served right now (owner unfollowed, root away, file gone):
  keep your copy and wait for the next event or selection change.
- `unavailable`: SubSmelt cannot write or serve the note. Keep what you have
  and mark it stale; a later `upsert` supersedes it. `reason` is one of:
  - `notes_root_missing`, `notes_root_unwritable`: the export is blocked by
    the notes folder; the video waits in SubSmelt until it is fixed.
  - `export_failed`: the export failed for another reason recorded on the row.
  - `note_missing`: the saved file is not in the notes folder although the
    folder is mounted (deleted or moved outside SubSmelt).
  - `note_unreadable`: the saved path is outside the notes folder (the folder
    setting changed after the note was written) or cannot be read.
- `remove`: the note has stayed missing under a mounted notes folder for at
  least a day, so SubSmelt no longer expects it back. What a mirror does with
  its copy is its own policy. A later `upsert` brings the note back.

The same reason for the same video is recorded once, not on every retry; a
`remove` is recorded once. Every write is recorded, even to the same path,
because the body may differ.

**What is journaled.** Every time a note file is renamed into place by an
atomic export, the row's `note_path` and the journal event commit in the same
SQLite transaction, so the feed never names a note the database does not
have. Also journaled: a blocked export (once per reason), a video taken over
by another playlist (its newest event is repeated under the new owner), and
what the reconciliation finds (next section).

**Errors.**

| Status | `code` | When | What to do |
|---|---|---|---|
| 400 | `cursor_malformed` | `after` is not a cursor of this API | Fix the client; do not guess a cursor |
| 400 | — | `limit` outside 1..100, or an unknown query key | Fix the request |
| 410 | `cursor_generation` | The cursor names another journal generation | Start again from an empty `after`; the body carries the current `generation` and `head` |
| 410 | `cursor_ahead` | The sequence is beyond the head: the database was restored from an older backup or the journal was reset | Start again from an empty `after` |

A cursor is never silently moved. The 410 body is
`{ "error", "code", "generation", "head" }`.

### Bootstrap and migration

On the first start of 0.7.1 (and on every later start, at the cost of one
query over the video table) SubSmelt gives every row that has no journal event yet its
first event: an `upsert` for each note written before the journal existed
whose path lies inside the notes folder, `unavailable` / `note_unreadable`
for a saved path outside it, and `unavailable` with the matching reason for
each export the notes folder blocks. Rows without a note and without a block
get nothing. So a new mirror bootstraps from the feed alone:

1. Call `GET /api/youtube/notes/sync-state`; remember `selection` and
   `selectionRevision`.
2. Page `GET /api/youtube/notes/changes?limit=100` from an empty `after`
   until `hasMore` is false, applying every event to an index keyed by
   `videoId` (owner, path, kind, title). Keep events of every playlist, not
   only selected ones, so a later selection needs no second walk.
3. Fetch bodies for notes whose `kind` is `upsert` and whose owner is in
   `selection`.
4. Store `nextCursor`; from then on poll both endpoints.

A mirror that wants only future changes starts from the `head` in sync-state
instead of an empty `after`.

### Selection changes and reconciliation

Selection is not part of the feed: ticking, unticking, following and
unfollowing never add events. On every poll compare `selectionRevision`:

- Unchanged: apply new feed events as above.
- Changed: re-read `selection`. For every note in your index, it is mirrored
  exactly when its owner's `playlistId` is in `selection` and its newest
  kind is `upsert`. Fetch bodies for notes that became selected; retire (or
  keep, by your policy) notes whose owner left the list. An unfollowed
  playlist's notes return 404 from the detail route; a re-followed and
  selected one serves them again without new events, which is why the index
  keeps them.

A playlist taking over a video from an unfollowed one is journaled as an
`upsert` under the new `playlistId`, so ownership moves do arrive through
the feed.

### Notes changed outside SubSmelt

SubSmelt writes notes; it does not watch them. A note deleted, moved or
edited in Obsidian or by a sync tool is not detected at the moment it
happens. Instead the worker runs a **bounded reconciliation**: every ten
minutes it checks the next 200 saved notes (by video id, wrapping around)
against the notes folder with one `stat` each, and journals what differs:

- a file that is gone becomes `unavailable` / `note_missing`, then `remove`
  once it has stayed gone for 24 hours;
- a file that is back, or a note the journal does not know, becomes an
  `upsert`;
- a row whose path changed without an event (for example after running
  0.7.0 again for a while) becomes an `upsert` with `previousNotePath`.

Nothing is checked while the notes folder is missing or empty, so an
unmounted or freshly mounted empty folder never reads as every note deleted.
A note edited in place is **not** detected: its body changes but no event is
recorded until SubSmelt re-exports it. Re-export from the video's row (or
`POST /api/youtube/videos/:videoId/note`) to push a fresh body through the
feed. Changing `youtube_notes_dir` does not re-journal old notes; they become
`note_unreadable` as the reconciliation reaches them.

### Retention and reset

Nothing is pruned in 0.7.1. One event is about 200 bytes; a library of ten
thousand notes with a few re-exports each stays within a few megabytes, and
every cursor ever handed out keeps replaying the same page. If pruning is
added later it will keep the newest event of every video forever and delete
only older, superseded events behind a floor; a cursor below that floor will
be refused with `410` and a new code `cursor_expired`, and a client that
starts again from an empty `after` still receives the complete current state.
The generation changes only if the journal is rebuilt, which no code path
does in 0.7.1; clients must treat `cursor_generation` and `cursor_ahead` the
same way: start again.

### Security and privacy

- The feed and sync-state carry no note bodies, no host paths and no
  settings: paths are relative to the notes folder, reasons are fixed codes
  rather than error text (the row's own error text can name the folder's
  host path and is not copied), and the folder's health is two booleans.
- They expose what `GET /api/youtube/notes` already exposes (titles, owning
  playlist ids, relative paths) and nothing more; bodies still come only from
  the detail route with its path checks.
- Like the rest of the SubSmelt API they carry no authentication; keep the
  app on a private network as before.
- Nothing is promoted, copied or sent anywhere: the journal is a local table
  the mirror reads.

## Known limits

- Notes of a playlist that has since been unfollowed keep their old folder.
  They are not on the allowlist unless a selected playlist uses that same
  folder name, and the detail route does not serve them until the playlist is
  followed again or another followed playlist takes the video over.
- Changing a playlist's folder moves a note only when the note is written
  again. Until then, older notes stay in the old folder.
- The allowlist describes folders, not files. A mirror that copies a listed
  folder copies whatever is in it, including files put there by hand. A
  mirror that works from the change feed copies only notes SubSmelt wrote.
- Edits made to a note outside SubSmelt are not reported by the feed; see
  "Notes changed outside SubSmelt".
- Playlists edited by hand in `config.json` bypass the routes but not the
  feed: selection is always read live, so sync-state reflects them on the
  next poll.
