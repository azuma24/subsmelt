# SubSmelt

**Self-hosted subtitle translator for your media library.**

Point SubSmelt at your media folders and it automatically translates every subtitle file into any number of target languages — using your local GPU, a home server, or a cloud API key. No subscription, no data leaving your network unless you choose it.

One subtitle file. Multiple language outputs. Fully automated.

---

## Quick Start

```yaml
services:
  subsmelt:
    image: ghcr.io/azuma24/subsmelt:latest
    container_name: subsmelt
    ports:
      - "3000:3000"
    volumes:
      - /share/Container/subsmelt/config:/app/config
      - /share/Container/subsmelt/data:/app/data
      - /share/Media Data/Media/downloads:/media
    environment:
      - TZ=America/New_York
      # - PUID=1000   # optional: run as this user so config/ and data/ stay editable on the host
      # - PGID=1000
    restart: unless-stopped
```

Replace the media path and timezone, then open `http://YOUR-HOST-IP:3000`.

Map as many media folders as you like — the container scans `/media` recursively:

```yaml
volumes:
  - /nas/movies:/media/movies
  - /nas/anime:/media/anime
```

---

## Why LLM translation

SubSmelt sends whole chunks of subtitles to a language model rather than
translating sentence-by-sentence through a dictionary engine. That buys context
across lines, consistent character names, preserved tone and register, and
phrasing that fits on screen. The tradeoff is a real API call per chunk, which
costs nothing against a local endpoint.

→ **[The full argument, with the mechanics](docs/why-llm-translation.md)**

---

## Features

- **Multi-language output** — one `.srt` generates Traditional Chinese, Simplified Chinese, Japanese, Korean and any other language in parallel
- **One naming standard** — every file SubSmelt writes uses the three-letter code (`Movie.eng.srt`, `Movie.kor.srt`); your preferred Chinese is `.chi`, the other script `.chs`/`.cht`. Existing files in other spellings (`.en`, `.zh-TW`) are recognised, never renamed or translated twice
- **Local or cloud LLM** — LM Studio, Ollama, vLLM or GPUStack on your own hardware, or OpenAI, Anthropic and Google Gemini with an API key; several connections in single, fallback or parallel mode, with live status in the sidebar
- **Context-aware chunking** — 20-line chunks with a 5-line overlap, plus a glossary pre-pass on longer files that keeps names and terms consistent
- **Adaptive parallelism** — probes the model's real context window, then auto-tunes chunk count and worker count
- **Batch and automatic** — scans your whole library (recursive, root-only or hand-picked subfolders), and a file watcher queues new subtitles within seconds of them appearing
- **Queue management** — priority pinning, force re-translate, graceful stop, already-translated detection, and resume on restart
- **Crash safety** — work in progress goes to a `.part` file and is only renamed on completion, so an interrupted job is retried rather than left truncated
- **Real-time progress** — live job progress over Server-Sent Events with time remaining and throughput, and failures mapped to a cause and a next step
- **Subtitle preview** — side-by-side original vs translated with full-text search
- **Translated title sidecar** (optional) — stores each media title translated into every target language in a `.subsmelt_titles.json` next to the output, shown in the scan results; filenames on disk are never renamed
- **YouTube to notes** — follow a playlist or a channel (Shorts and live streams optional); new videos are downloaded, subtitled, translated and saved as Markdown notes for Obsidian. Older videos stay listed so you can pick the ones you want
- **Optional speech-to-text** — attach a Whisper backend to generate source subtitles when none exist; transcripts are named with their language, and Chinese is converted to your preferred script
- **Formats** — `.srt`, `.vtt`, `.ass`, `.ssa` · **UI** — 32 locales

---

## How It Works

### 1. Configure your LLM

Open **Settings → LLM Connection** and add one or more connections:

| Type | Use case |
|------|----------|
| **Local** | Self-hosted endpoint — LM Studio, Ollama, vLLM, GPUStack |
| **OpenAI / Anthropic / Gemini** | Your API key and a model |

With several connections, pick a mode: **single**, **fallback** (try them in order) or **parallel** (spread chunks across them). The sidebar shows which connection is translating and whether each one answers.

For local endpoints, **↻ Fetch models** pulls the model list and **Test Connection** verifies it. In LM Studio, load the model with a context length of 16k or more.

### 2. Add translation targets

Open **Settings → Languages**. Use quick-add presets or define custom targets — target language and output pattern (default `{{name}}.{{lang_code}}.srt`). One input file generates one output file per enabled language. Set **Preferred Chinese** under **Settings → Sources** to choose which script `.chi` means.

### 3. Scan and translate

Open **Library** and press **Scan**. Every video is listed with one chip per language; filter by errors, missing languages or in-progress work, and open a file to translate, retry or transcribe it. **Activity** shows the queue.

### 4. Automate it

Enable **File Watcher** in Settings. New subtitle files are detected and queued within seconds.

---

## Optional: Speech-to-Text

SubSmelt translates existing subtitle files by default. To generate source subtitles from video/audio, attach a faster-whisper backend:

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml up -d
```

Then set **Settings → Speech-to-text → Backend URL** to `http://whisper-backend:8001`. If the backend has a token set, put it in **Backend token** on the same page — see [Security](#security).

For NVIDIA GPU acceleration, add the GPU overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml -f docker-compose.whisper.gpu.yml up -d
```

Two model families are available, and **Settings → Speech-to-text models** downloads them on demand:

| Family | Models | Strength |
|--------|--------|----------|
| Whisper (faster-whisper) | `tiny` to `large-v3`, `large-v3-turbo`, `distil-large-v3` | 99 languages. Best for Chinese and rare languages. |
| NVIDIA Nemotron | `nemotron-3.5-asr` (742 MB GGUF) | Fast, punctuated, word-level timing. English, Japanese, Korean, Mandarin and most European languages (32 locales). |

Nemotron runs through the bundled [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) runtime (`nemo-speech`). The Docker image and the Windows installer ship it; a source install sets `SUBSMELT_NEMO_SPEECH` to the binary or puts `nemo-speech` on `PATH`. Beam size, prompt and compute type do not apply to Nemotron and are hidden when it is selected. On Windows the GPU build needs an NVIDIA driver R580 or newer (CUDA 13).

Key STT settings (all in the web UI):

| Setting | What it controls |
|---------|-----------------|
| Model / device / compute | Whisper size or Nemotron, CPU/GPU, `int8` / `float16` (Whisper only) |
| Language / output format | Auto-detect or explicit source language; `.srt`, `.vtt`, `.txt` |
| Missing-subtitle behavior | Ask, auto-transcribe, or auto-transcribe + translate |
| Low-RAM behavior | Ask, downgrade model, skip, or run anyway |
| Per-folder defaults | Model, language, and quality overrides per folder path |

Example per-folder config:

```json
[
  { "path": "/media/anime", "language": "ja", "model": "small" },
  { "path": "/media/lectures", "language": "en", "model": "medium",
    "advanced_options": { "beam_size": 7, "initial_prompt": "Technical lecture." } }
]
```

For a smoke test without downloading model weights:

```bash
SUBSMELT_WHISPER_FAKE=1 docker compose -f docker-compose.yml -f docker-compose.whisper.yml up -d --build
```

Running the backend natively on Windows instead? See
**[backend-whisper/packaging/windows/README.md](backend-whisper/packaging/windows/README.md)**.

---

## Security

**SubSmelt has no authentication and listens on all interfaces.** Anything that
can reach port 3000 can browse your media paths, change settings, and queue
work. It is built for a trusted home network — put it behind a reverse proxy
with auth, or restrict it at the firewall, before exposing it more widely.

The optional Whisper backend also binds `0.0.0.0` by default, so that a
containerised SubSmelt can reach it. **Set a token** if it is reachable from
anywhere you do not control; it warns at startup when it binds wide without one.
`SUBSMELT_WHISPER_HOST=127.0.0.1` keeps it local-only instead.

The backend can generate the token for you — `run_server --generate-token`, or
the **Generate** button in the Windows control window. Set it in **both places**:
the backend enforces it and SubSmelt has to send it, or every health, model and
transcription request comes back `401`.

```yaml
services:
  subsmelt:
    environment:
      - WHISPER_BACKEND_TOKEN=${WHISPER_TOKEN}
  whisper-backend:
    environment:
      - SUBSMELT_WHISPER_TOKEN=${WHISPER_TOKEN}
```

In the web UI the same secret goes in **Settings → Speech-to-text → Backend token**.

State-changing requests from other websites are refused, so a page you visit
cannot drive SubSmelt through your browser.

API keys and the notification webhook are stored in `config.json` and redacted
from API responses, but that file is plaintext on disk — back it up somewhere
private. Values set through environment variables are never written to it.

---

## Configuration

Three mounts, all of which have an environment override:

| Mount | Variable | Default | Purpose |
|-------|----------|---------|---------|
| `/app/config` | `CONFIG_DIR` | `/app/config` | `config.json` — all settings and translation tasks. **Back this up.** |
| `/app/data` | `DATA_DIR` | `/app/data` | SQLite DB and log files. Safe to delete if the queue gets stuck. |
| `/media` | `MEDIA_DIR` | `/media` | Your video and subtitle files (read/write). |

Everything else:

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | `UTC` | Timezone for log timestamps |
| `PUID` / `PGID` | — | Run as this user and group; `config/` and `data/` are handed to them (media is left alone). Unset: runs as root, as before |
| `PORT` | `3000` | Web server port |
| `HOST` | `0.0.0.0` | Interface the web server binds; `127.0.0.1` keeps it local to the machine |
| `LLM_ENDPOINT` | — | Override LLM endpoint on startup |
| `API_KEY` | — | Override API key on startup |
| `MODEL` | — | Override model name on startup |
| `WHISPER_BACKEND_URL` | — | Optional speech-to-text backend URL |
| `WHISPER_BACKEND_TOKEN` | — | Shared secret for the STT backend — must match its `SUBSMELT_WHISPER_TOKEN` |
| `WHISPER_TRANSPORT` | `auto` | `shared` (backend reads `/media` directly) or `upload` |

---

## Development

```bash
git clone https://github.com/azuma24/subsmelt
cd subsmelt
docker compose up -d      # or: npm ci && npm run dev
```

```bash
npm run dev          # API (tsx watch) + Vite dev server
npm test             # node:test across src/**/*.test.ts(x)
npm run typecheck    # client AND server TypeScript projects
npm run lint         # Biome (lint + format check), then the typechecks
npm run format       # rewrite the tree with Biome
npm run build        # typecheck, then vite build, then tsc for the server
```

The Python sidecar has its own suite, which must be run from its directory:

```bash
cd backend-whisper
pip install -r requirements.txt pytest ruff
python -m pytest tests -q
ruff check . && ruff format --check .
```

`vite build` does not typecheck, so run `npm run typecheck` before assuming a
change is clean. CI runs Biome and ruff, both suites, both
typechecks, the production build, and builds and starts the Docker image on
amd64 and arm64 on every pull request.

Building an image by hand, or cross-building for `linux/amd64` on Apple Silicon:

```bash
docker build -t subsmelt:latest .
docker buildx build --platform linux/amd64 -t subsmelt:latest .
```

New to the codebase? Start with **[docs/HANDOFF.md](docs/HANDOFF.md)** — layout,
the parts worth understanding first, the release process, and the known gaps.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 LTS (engines: >=20 <25) |
| Backend | Express 5, better-sqlite3 |
| Frontend | React 19, Vite 8, Tailwind CSS 4 (Safari 16.4+, Chrome/Edge 111+, Firefox 128+) |
| Real-time | Server-Sent Events |
| Translation | Vercel AI SDK (local + OpenAI / Anthropic / Gemini) |
| Optional STT | Python FastAPI sidecar + faster-whisper / Nemotron, OpenCC |
| File watch | chokidar |
| i18n | Own runtime (`src/client/i18n`), 32 locales |
| Container | Single Dockerfile, no external services required |
| Tooling | TypeScript 7, Biome, ruff |

---

## Credits

Translation engine ported from [subtitle-translator-electron](https://github.com/gnehs/subtitle-translator-electron) by gnehs (MIT License).
