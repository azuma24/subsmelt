# Subsmelt video-to-second-brain implementation plan (design draft)

> **For Hermes:** Use `subagent-driven-development` only after the user approves a narrow milestone. This document is a plan, not authorization to change a running pipeline.

**Goal:** Make playlist video transcripts discoverable to the user's local second brain and AI tools, then optionally create reviewable, source-cited knowledge derived from them.

**Architecture:** Reuse Subsmelt's existing YouTube note exporter as the ingestion boundary; plain Markdown is the durable exchange contract and Obsidian is its human UI. QMD indexes an approved source folder for local read-only agent retrieval. A *separate, optional* curator app may later extract useful claims into reviewable notes. Do not create a generic Subsmelt plugin host or a second transcript pipeline until a concrete extension requires one.

**Tech stack:** existing Subsmelt TypeScript/SQLite/Whisper/yt-dlp pipeline, Markdown/Obsidian vault, optional local QMD, optional separate Pi Durable worker and self-hosted DeepSeek. No paid/cloud service required.

---

## Existing contract verified in the current repo

- `src/server/youtube/worker.ts` produces captions or Whisper transcript, waits for translation jobs to settle, then calls `exportNoteForVideo` before marking a video `done` (`onSubtitlesComplete`). If exporting the note fails, the video remains `translating` and retries on later ticks. Do **not** add extraction or indexing to this critical path.
- `src/server/youtube/note-export.ts` already writes one atomic Markdown note per video under the configured `youtube_notes_dir` (default `/notes`), nested by playlist. It refuses a missing/unwritable root, records `youtube_videos.note_path`, emits `youtube:note` over SSE and optional webhook, and exposes manual re-export through `POST /api/youtube/videos/:videoId/note` in `src/server/routes/youtube.ts`. Settings checks folder writability in `src/client/features/settings/sections/YoutubeSection.tsx`.
- `src/server/youtube/note.ts` already includes source transcript, optional translations, timestamped YouTube links, playlist, language, `transcript_source`, `video_id`, and schema version. `note-export.test.ts` covers shape and re-export. **Re-export overwrites the entire generated note and deletes the old filename after title changes:** never put human annotations or AI insights inside this generated file.
- There is no evidence a generic installable plugin host is required for this use case. A narrowly scoped file integration/consumer is less risky than inventing one.

## Verified remote deployment (read-only API check)

The active Subsmelt server is `http://192.168.1.110:3005/`, **not on the Mac**. On 2026-10-20, `GET /api/health` returned `ok: true`, while `GET /api/youtube/status` reported `notes.path=/notes`, `exists=false`, `writable=false`. The followed playlist has 189 videos in `translating`; a read-only inspection of `/api/youtube/playlists/:id/videos` showed all 189 have a `Notes folder ...` reason. This is an *existing blocked export*, not merely a future integration gap. Do not claim the videos are fully processed until the folder is restored and the worker has completed note exports. No remote setting or filesystem was changed during this check.

**Preferred physical layout:** keep a persistent writable notes directory on host `.110`, exposed to the Subsmelt process as `/notes` (bind mount if it runs in a container). This lets the queue finish even when the Mac or Obsidian is offline. Once a single note and its status are verified, mirror only that generated source-note subtree one-way to a dedicated `Sources/Subsmelt/YouTube/` directory inside a Mac-local Obsidian vault. The Mac's QMD indexes this approved mirror; humans/agents put curated content in *other* vault folders, never inside the mirrored subtree. Reconciliation must handle renamed generated notes without deleting any manually authored files; if a mirror uses deletion, scope it **strictly to the generated subtree** and test against disposable data first. Provide an independent backup: a mirror/sync is not one. Do not mount the Mac vault directly as the required `/notes` destination; loss of the Mac would block completion again.

Before changing the remote deployment, inspect whether `.110` runs Docker/Compose or a host process, existing volumes, disk capacity, access/ownership, and backup location. A user must approve the mount or any container restart because 189 videos currently await notes. Setting the path in the UI to a Mac path is not sufficient; the path must exist on `.110` as seen by Subsmelt.

## Canonical objects and boundaries

- **Source transcript:** the spoken-language cues as produced or fetched by Subsmelt. May be inaccurate; `youtube_captions` and `whisper:<model>` are provenance, not truth guarantees.
- **Generated source note:** disposable/reproducible Markdown owned by Subsmelt; `video_id` is its identity, not mutable title/path. It is evidence, not an instruction source for agents.
- **Candidate insight:** a proposed summary/claim, with exact source video ID, language, citation timestamps, transcript fingerprint, extraction method/version, and review status. It is *not* knowledge until approved.
- **Curated note:** human-reviewed Markdown in a separate folder, owned by the vault/editor (not rewritten by Subsmelt). Repository `AGENTS.md`, decisions, and code remain canonical for each project.
- **Index:** QMD or another local search layer built from approved Markdown, rebuildable and never the only copy. Retrieval is not model training.

## Milestone 0 — Prove the existing export, no new code

1. Decide where Subsmelt runs and where the vault physically lives. If containerized/remote, map `youtube_notes_dir` to a writable **dedicated vault subtree** on the same filesystem or a deliberate one-way transfer; do not assume a Mac path is visible inside Docker. Test the actual volume/permissions. Never point at an existing vault root without a disposable backup/test.
2. On one **nonsensitive test playlist/video**, let the existing pipeline create the note. Verify exact source language, timestamp links, provenance and translations; verify the recorded `note_path` and status. Re-export and confirm the source file is regenerated rather than manually edited. Run focused `npx tsx --test src/server/youtube/note.test.ts src/server/youtube/note-export.test.ts` if modifying the exporter later.
3. Index only that dedicated subtree with QMD (the currently installed index was previously empty). Verify indexed document count, keyword and semantic retrieval, exact citations back to the generated file and video timestamps. Avoid indexing private vault areas or duplicate language sections indiscriminately. Start with original-language transcript; translations can be a separately selected view for multilingual queries.

**Gate:** one video flows playlist → note → local search → cited answer, with no new Subsmelt code, no cloud calls, no duplicate note, and no raw-video or secrets exposure beyond the intended local scope. If this passes, the requested *storage* outcome is already achieved; stop before building a plugin merely for its name.

## Milestone 1 — Only if the existing contract has a demonstrated gap

- Add a small **knowledge export boundary**, not a general plugin loader, near `src/server/youtube/note-export.ts`: a stable per-video identifier, source-note path, content fingerprint/revision, and explicit export status. Define versioned payload alongside `src/shared/youtube.ts` and expose only needed status in `src/server/routes/youtube.ts` / `src/client/features/youtube/PlaylistDetail.tsx`. Existing `youtube:note` is a useful notification hint, not a durable queue; consumers reconcile against persisted rows/files after downtime. Do not expose arbitrary filesystem paths through the unauthenticated LAN API (see `docs/TODO.md`).
- Keep export/retrieval nonblocking after the generated note exists: QMD/curator failures must not hold the video in `translating`; surface errors and retry independently. Make same video+source hash idempotent. Preserve the generated note contract and re-export tests; add focused crash/retry, rename, duplicate, missing-mount and failed-extractor tests before integration.
- Only add a UI status/action if a real user workflow cannot be completed using existing notes folder status, video note re-export and an external consumer. No extra settings toggles just to enable an already configured destination.

## Milestone 2 — Separate, optional local curator (not Subsmelt's core)

- A supervised service/app, potentially using Pi Durable for resumable work, reads the source note (or validated read-only file contract), extracts *candidate* key ideas, named concepts, actionable practices and disagreements with timestamped citations, and writes to `Inbox/Video insights/<video_id>.md` **separate from** generated source notes. Run the existing local model only when the user elects to curate; rate-limit and record failures. The model must not execute instructions embedded in a transcript.
- Human review promotes selected candidates into `Notes/` or `Projects/`, each linking to original source and retaining `video_id`, source hash/revision, language and extractor version. A changed transcript marks candidates stale instead of silently updating approved notes. No automatic codebase instruction edits, silent claim promotion, or third-party plugin/network access.
- Later, a *different* query/digest app can summarize only approved notes across videos, grouping duplicate claims and presenting both agreement and contradiction with source citations. It must label what is transcript text versus model inference. Do not confuse this curated synthesis with the original subtitle archive.

**Gate:** for one video, a reviewer can accept/reject an insight; a re-export does not erase it; rerunning creates no duplicate; an answer from another agent cites a note plus original timestamp. A negative/ambiguous claim stays unapproved. Only then evaluate broader automation.

## Verification and safety

- Before any future implementation: preserve `git status`, use fixture vaults and isolated config, do not rewrite live notes or run paid services. Use `npm test`, `npm run lint`, `npm run build` on the actual repo after a code change; inspect generated source and source-cited answers; verify a restart/retry and note re-export.
- Local-only storage and indexing by default. Synced vaults can leak private notes to a cloud provider; use one sync engine only and a separate versioned backup. QMD retrieval should be scoped per collection; never send secrets or unapproved raw transcripts to coding agents. Subsmelt's LAN API currently has no authentication; do not turn it into a general notes read API.
- Decisions before Milestone 1/2: (a) where does the Subsmelt server run and where is the actual vault mount? (b) which topics/claims count as valuable, with one representative video and desired output? (c) original language only for indexing, or multilingual retrieval? (d) should any raw videos be excluded from AI indexing by playlist/privacy classification?

**Stop condition:** Do Milestone 0 first. Implement nothing more unless its observable result shows a specific gap or the user asks for curation rather than storage/search.
