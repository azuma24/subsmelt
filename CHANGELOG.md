# Changelog

All notable changes to SubSmelt. The app and the Whisper backends (Windows
installer, macOS app) share a version number and are released together, as
`v<version>` and `whisper-v<version>`.

## [Unreleased]

## [0.7.8] — 2026-11-04

### Translation

- Experimental: in Parallel mode with two or more connections, a new setting splits each file across every connection, so one long file finishes sooner. Files run one at a time, and each server takes at most `parallel_chunks` requests at once, or what its context window fits. When no chunks are left to hand out, a stalled chunk also goes to another machine and the first complete answer is written. Off by default.
- Stop and Cancel now end a retry backoff or an availability probe at once instead of waiting it out.
- A job queued just as the last one finished no longer waits until Stop in Single or Fallback mode.

### Whisper backends

- No changes. Rebuilt so the version matches the app.

## [0.7.7] — 2026-11-03

The first release in this repository's current history. It describes what
SubSmelt does today; earlier releases are no longer published.

### Translation

- Translates every subtitle in your media folders into any number of target languages, with an LLM on your own hardware (LM Studio, Ollama, vLLM, GPUStack) or a cloud API key (OpenAI, Anthropic, Google Gemini).
- Several LLM connections in single, fallback or parallel mode. While a transcription runs on the machine that hosts an LLM, translation moves to the next connection and comes back when it ends.
- Context-aware chunks with overlap, a glossary pass for names and terms, and parallelism tuned to the model's real context window. Stalled requests are retried before moving to the next connection.
- One naming standard (`Movie.eng.srt`, `Movie.chi.srt`), with existing files in other spellings recognised and never translated twice.
- A file watcher queues new subtitles within seconds. Pinning, force re-translate, graceful stop, resume after a restart, and `.part` files so an interrupted job is never left truncated.
- Token usage and estimated cost per day, model, call type and file, with an optional monthly budget.

### Library

- One Library view with a **Jobs | Files** switch. Jobs lists every translation job, plus videos with no subtitles (Transcribe) and languages never queued (Translate). Files lists one row per video with a chip for each language: done, queued, translating, failed or not queued.
- Search, folder, language and status filters on both. A file opens its panel, where **Translate to…** adds any language; every row's ⋯ menu has it too.
- Live progress, subtitle preview with search and editing, and failures explained with a next step.

### Speech to text

- An optional Whisper backend creates source subtitles where none exist, with faster-whisper, NVIDIA Nemotron and, on a Mac, whisper.cpp on Metal. Models are downloaded from the model manager; a Windows backend never lists the Mac-only Whisper (Metal) models.
- **Windows backend** (`SubSmeltWhisperBackend-Setup-0.7.7.exe`): runs as the signed-in user from `%LOCALAPPDATA%\SubSmelt`, started by the tray at sign-in. Start, stop, restart and generating an API key never ask for administrator approval. Setup removes the service older versions installed and carries its port and key over.
- **macOS backend** (`subsmelt-whisper-macos-arm64-0.7.7.zip`): a LaunchAgent with a menu-bar app, controlled the same way from its window.

### Also

- The Convert page converts or translates single `.srt`, `.vtt`, `.ass` and `.ssa` files, detecting legacy encodings.
- YouTube: follow playlists or channels; new videos are downloaded, subtitled, translated and saved as Markdown notes, with an optional allowlist and change feed for a second-brain mirror.
- 32 interface languages.
