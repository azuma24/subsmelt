# Changelog

All notable changes to SubSmelt. The app and the Windows Whisper backend share a
version number and are released together (`v0.5.6` and `whisper-v0.5.6`).

## [Unreleased]

Nothing yet.

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

