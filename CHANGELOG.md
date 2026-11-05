# Changelog

All notable changes to SubSmelt. The app and the Whisper backends (Windows
installer, macOS app) share a version number and are released together, as
`v<version>` and `whisper-v<version>`.

## [Unreleased]

## [0.8.1] — 2026-11-05

### Translation

- New **Corrections**: find → replace rules for words that keep coming out wrong, grouped in lists that you switch on for folders (for example "Ubiquity" → "Ubiquiti" in a UniFi channel only). Open any file in the Library to see and switch the lists for its folder, or manage every list under **Settings → Corrections**. A rule is one line; type a pair and press Enter, or paste many lines of `wrong → right` at once. Each rule runs **before translation** (on the source subtitle and on every new Whisper transcript, so the translator reads the right word and is told to keep it), **after translation** (on the translated file, optionally for some languages only), or both. Rules match a whole word, text anywhere (for Chinese or Japanese), or a regular expression. Only cue text changes; numbers, timings, styling, line endings and the file's modification time stay as they were, and each job logs what it replaced. See [docs/subtitle-corrections.md](docs/subtitle-corrections.md).
- **Check with the translator**: a correction rule for a word that is also an ordinary word ("unify" the verb vs. the UniFi brand) can ask the LLM about each match, with the lines around it, and replace only those it confirms. An unclear answer or a failed request keeps the text as written. The cost shows under Settings → Usage as *Correction check*.
- Corrections also apply on the **Convert** page: lists on the whole library fix uploaded files too.
- Fix everywhere can **remember unticked files**: tick "Never apply this rule to the unticked files", and the rule keeps them as exceptions from then on. The rule's options list the exceptions and can clear them.
- Problems with a rule ("the replacement would be changed again", "lists undo each other") are now shown in the interface language.
- **Fix everywhere**: select a wrong word in a job's preview and click **Fix "…"**. The dialog saves the rule for the folder (or fixes just this file), lists every file that contains the word with before-and-after samples so you can untick the ones to leave alone, and can re-translate the translations made from fixed sources. Each list also has **Preview on my files**, which runs the same dry run for the whole list.

### Interface

- **Library folders**: a folder tree beside the list shows each folder's file count and a red dot when a translation in it failed. Pick a folder to see it with its subfolders. The status counts, filters and bulk actions (run pending, retry errors) then apply to that folder only. A header shows where you are, with a breadcrumb back up, the folder's counts and the correction lists that apply. Folders can be pinned, the open branches are remembered, and links keep the folder (`/?folder=UniFi/Tutorials`). On a phone the tree opens from a Folders button.
- The interface now comes in 10 languages instead of 32: English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português (Brasil) and Русский. Anyone who had picked another one sees English, except European Portuguese, which now shows Brazilian Portuguese. This changes only SubSmelt's own screens: every language is still available as a subtitle translation target and for Whisper.

### Whisper backends

- No changes and no new installers. The current backend release stays 0.8.0.

## [0.8.0] — 2026-11-04

### Settings

- Saving settings after a scan no longer shows "Not saved: media_scanned". The setting was never lost: the server records that flag itself.

### Whisper backends

- No changes. Rebuilt so the version matches the app.

## [0.7.9] — 2026-11-04

### Translation

- Faster start: the analysis pass now samples 500 lines by default instead of up to 5000, as the new **Analysis Sample** setting, and its reply is capped. A job shows "Analyzing file…" with a timer during this pass instead of sitting at 0%. Connections are probed at the same time, so a silent host costs its timeout only once.
- A retried or restarted job reuses its saved analysis instead of running the pass again, unless the source file, languages, prompt or Additional Context changed, or you force a re-translate.
- A stopped, failed or interrupted job continues where it left off instead of translating the whole file again. Finished chunks are saved beside the `.part` file and removed when the job ends. A forced re-translate starts over.

### Whisper backends

- No changes. Rebuilt so the version matches the app.

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
