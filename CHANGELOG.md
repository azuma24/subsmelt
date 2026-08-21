# Changelog

All notable changes to SubSmelt. The app and the Windows Whisper backend share a
version number and are released together (`v0.5.6` and `whisper-v0.5.6`).

## [Unreleased]

Nothing yet.

## [0.5.7] — 2026-08-21

App-only release (the Whisper backend is unchanged; `whisper-v0.5.6` remains
current).

### Added

- **File trees got a real redesign across every panel** (Transcribe library,
  Dashboard scan results, Settings media sources). Expand/collapse state now
  persists per folder in `localStorage` and survives refresh and reload —
  folders you have never opened start collapsed. Depth is readable at a glance:
  indentation plus vertical guide rails, sticky folder headers that stack two
  deep (deeper levels pin with an ancestor-path hint), and item counts on every
  folder row. On phones, deep nesting switches to drill-down navigation with a
  breadcrumb bar instead of unreadable indentation. Folder checkboxes select
  all descendants with a proper indeterminate state, and a text filter shows
  matches as a flat list labelled by relative path so hits from any depth are
  unambiguous.
- **The Subtitle Converter now detects each file's source language** from its
  first cues (in the browser, via `franc`) and shows it as a per-file badge,
  with an optional per-file override — no source dropdown to fill in. The
  target language is a free-text field that accepts BCP-47 codes ("zh-TW"),
  English names ("Japanese"), or native names ("繁體中文"), with autocomplete,
  typo suggestions, and recent-target chips. "Chinese" alone is never silently
  resolved — the field asks Simplified or Traditional. Output files are named
  with the canonical code (`video.zh-TW.srt`), each file converts
  independently with its own progress so one failure never aborts the batch,
  and files whose source already equals the target can be skipped inline.
- **Translation prompts now explicitly preserve formatting** — cue timing,
  line breaks, and inline tags (HTML-like, VTT voice tags, ASS/SSA override
  codes) are called out as untouchable, and Traditional Chinese targets are
  instructed to write native Taiwan-convention zh-TW rather than mechanically
  converted Simplified.

### Changed

- **The dashboard queue table's columns finally line up with their headers.**
  Header and rows are separate CSS grids, so the old `max-content` column
  tracks resolved differently in each — replaced with fixed tracks.
- **Row actions collapsed into one primary button plus a ⋯ menu** on both the
  desktop table and mobile cards (Re-translate, Logs, Details, and Delete live
  in the menu). Mobile cards lost three stacked full-width buttons each; the
  desktop table lost its orphaned "×" delete glyph.
- **"Whisper" is now "Transcribe" in the navigation and page title**, in all
  31 languages — the model name was jargon; the verb says what the page does.
- **Quieter dashboard**: zero-count stat tiles render muted instead of
  alarm-red "0", and zero-count bulk-action buttons are hidden instead of
  disabled. The Transcribe page uses the same sticky title bar as the
  Converter, scan actions collapse into a menu on phones, and the queue's
  Target column is a single muted line.
- **Large modules were split for maintainability** — the whisper page,
  dashboard panels, converter page, translator engine/utils, and the
  transcription server modules are now composed of focused files; no behavior
  change, all export paths preserved.

### Fixed

- **Path traversal in `/api/convert`**: a crafted `name` in the JSON body
  could escape the temp directory via `path.join`. Names are now stripped to
  their basename before any filesystem use, and language fields entering the
  LLM prompt are length-capped and sanitized.

## [0.5.6] — 2026-08-13

First public release.

### Added

- **The Whisper backend generates its own API key.** Every hardening message so
  far ended at "set `SUBSMELT_WHISPER_TOKEN`", which asks the operator to invent
  a secret — so in practice they picked a weak one or skipped it and left a
  `0.0.0.0`-bound backend open to the network. Now the backend hands one out:
  - **Control GUI:** a **Generate** button beside the API key field mints a
    256-bit key, reveals it, and copies it to the clipboard. **Copy** and
    **Show/Hide** sit next to it (the field is masked by default, so the window
    is safe to leave open while screen-sharing). Generating does not save or
    restart — press **Start**/**Restart** to apply, since rotating the key
    breaks every client still using the old one.
  - **Headless installs:** `run_server --generate-token` prints a key,
    `--save` writes it into `config.json`, and `--force` is required to replace
    a token already stored there. It warns when `SUBSMELT_WHISPER_TOKEN` is set
    in the environment, which takes precedence over the file.
  - **Service installer:** `install-service.ps1 -GenerateToken` mints one during
    install and prints it, delegating to the launcher so all three paths use the
    same generator.

  All of them name where the key goes: **Settings → Speech to Text → Backend
  token**.

### Fixed

- **Three dead paths in the Windows control window**, which between them made
  start-failure reporting silently absent:
  - `self.active` was initialised and cleared but never assigned, so the status
    line could only ever show a bare "● Running". It never named the bind
    address and port, never showed the **⚠ no token** warning for a backend
    open to the network, and never flagged edited fields as needing a restart.
  - `_await_ready` — the `/health` poll that catches a server dying *after* the
    two-second startup grace, which is the common case when CUDA probing runs
    long — was defined but never called. A backend that started and then failed
    to bind sat there reporting success.
  - Even once called, it could not have reported anything: it published through
    Tkinter's `after()` from a worker thread, which queues into that thread's
    Tcl apartment and is never serviced by the main loop. No exception, no
    callback, message discarded. Worker threads now hand text to the Tk thread
    through a queue that the window drains on its own timer.

  The status line, the readiness message, the late-failure message and the
  no-token warning all now reach the window. Covered by 17 new tests against
  the extracted pure helpers.

