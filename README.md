# SubSmelt

**Self-hosted subtitle translator for your media library.**

Point SubSmelt at your media folders and it automatically translates every subtitle file into any number of target languages — using your local GPU, a home server, or a cloud API key. No subscription, no data leaving your network unless you choose it.

One subtitle file. Multiple language outputs. Fully automated.

---

## Why LLM translation beats traditional MT

Most subtitle translation tools call a dictionary-based engine (Google Translate, DeepL) one sentence at a time. SubSmelt doesn't. It sends **whole chunks of subtitles together** to a large language model, which changes the result in several concrete ways:

**Context carried across lines.** A line like *"He did it again"* is ambiguous alone. Sent alongside the surrounding five exchanges, the model reads who "he" is, what "it" refers to, and how formal the register should be — and picks the right phrasing. Traditional MT has none of that.

**Character names and proper nouns stay consistent.** For files over 500 cues, SubSmelt first runs a quick analysis pass to extract recurring names, technical terms, and style notes into a glossary. Every chunk that follows sees that glossary. A character named 佐藤 doesn't become Sato in one subtitle and Satou in the next.

**Tone and register are preserved.** LLMs understand that an anime character speaking in keigo should sound formal, that a slang-heavy crime drama should stay gritty, and that children's content should simplify vocabulary. A word-level MT system has no concept of register.

**Natural phrasing, not word-for-word rendering.** Subtitle translation requires short, punchy lines that fit on screen. LLMs rephrase naturally to hit that constraint. Traditional MT often produces awkward literal output that has to be manually post-edited.

**Reasoning models go further.** Models like Qwen3, DeepSeek-R1, and Gemini Thinking reason explicitly before committing to a translation. For ambiguous lines — idioms, wordplay, cultural references — you see higher-quality output because the model pauses to consider alternatives.

The tradeoff is cost: each chunk is a real API call. SubSmelt minimises that with adaptive chunking (20 lines per call by default), parallel workers, automatic context probing, and a skip threshold that skips the analysis pass entirely for short files.

---

## Features

- **Multi-language output** — One `.srt` generates Traditional Chinese, Simplified Chinese, Japanese, Korean, and any other language in parallel
- **Local or cloud LLM** — Use LM Studio, Ollama, vLLM, GPUStack on your own hardware, or connect to OpenAI, Anthropic, or Google Gemini with an API key
- **Chunked context window** — 20-line chunks with a 5-line overlap window carry dialogue context across boundaries
- **Automatic context analysis** — For longer files, a pre-pass extracts a glossary of names and terms injected into every chunk
- **Adaptive parallel workers** — Probes the model's actual context window via the LM Studio native API, then auto-tunes chunk count and parallelism
- **Batch processing** — Scans your entire library and queues every subtitle file automatically
- **Real-time progress** — Live job progress via Server-Sent Events, with a time-remaining estimate and throughput
- **Failures that explain themselves** — Raw errors are mapped to a cause and a next step, with the original text kept alongside
- **File watcher** — Drop a new subtitle into your media folder and it's auto-detected and queued within seconds
- **Scan modes** — Recursive, root-only, or hand-picked subfolders
- **Subtitle preview** — Side-by-side original vs translated view with full-text search
- **Crash safety** — Work in progress is written to a `.part` file and only renamed on completion, so an interrupted job is retried rather than left as a truncated subtitle
- **Smart skipping** — Already-translated files are detected and skipped
- **Queue management** — Priority pinning, force re-translate, graceful stop, resumes on restart
- **Supported formats** — `.srt`, `.vtt`, `.ass`, `.ssa`
- **Optional speech-to-text** — Connect a faster-whisper backend to generate source subtitles when none exist
- **Multi-language UI** — 32 locales including English, 繁體中文, 简体中文, 日本語, 한국어, Español, Français, Deutsch

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
    restart: unless-stopped
```

Replace the media path and timezone, then open `http://YOUR-HOST-IP:3000`.

---

## How It Works

### 1. Mount your media

The container scans `/media` recursively. Map your host paths there:

```yaml
volumes:
  - /nas/movies:/media/movies
  - /nas/anime:/media/anime
  - /nas/tv:/media/tv
```

### 2. Configure your LLM

Open **Settings → LLM Connection**. Four tabs:

| Tab | Use case |
|-----|----------|
| **Local** | Self-hosted endpoint — LM Studio, Ollama, vLLM, GPUStack |
| **OpenAI** | Enter your `sk-...` key, pick `gpt-4o` or `gpt-4.1-mini` |
| **Anthropic** | Enter your `sk-ant-...` key, pick Claude Sonnet or Haiku |
| **Gemini** | Enter your `AIza...` key, pick `gemini-2.5-flash` or `gemini-2.5-pro` |

Each provider stores its key and model independently — switching tabs doesn't lose your settings for the others.

For local endpoints, click **↻ Fetch models** to pull the model list, then **Test Connection** to verify.

### 3. Add translation targets

Open **Translations**. Use quick-add presets or define custom targets — source language, target language, output filename pattern (e.g. `{{name}}.chi.srt`). One input file generates one output file per enabled task.

### 4. Scan and translate

**Dashboard → Scan Folders**, then **Run All**. The file tree shows every video, its subtitles, and translation status per language.

### 5. Automate it

Enable **File Watcher** in Settings. New subtitle files are detected and queued within seconds.

---

## Optional: Speech-to-Text

SubSmelt translates existing subtitle files by default. To generate source subtitles from video/audio, attach a faster-whisper backend:

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml up -d
```

Then set **Settings → Speech-to-text → Backend URL** to `http://whisper-backend:8001`.

For NVIDIA GPU acceleration, add the GPU overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml -f docker-compose.whisper.gpu.yml up -d
```

Key STT settings (all in the web UI):

| Setting | What it controls |
|---------|-----------------|
| Model / device / compute | faster-whisper model size, CPU/GPU, `int8` / `float16` |
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

---

## Security

**SubSmelt has no authentication and listens on all interfaces.** Anything that
can reach port 3000 can browse your media paths, change settings, and queue
work. It is built for a trusted home network — put it behind a reverse proxy
with auth, or restrict it at the firewall, before exposing it more widely.

The optional Whisper backend also binds `0.0.0.0` by default, so that a
containerised SubSmelt can reach it. **Set `SUBSMELT_WHISPER_TOKEN`** if it is
reachable from anywhere you do not control; it warns at startup when it binds
wide without one. `SUBSMELT_WHISPER_HOST=127.0.0.1` keeps it local-only.

Set the token in **both places** — the backend enforces it and SubSmelt has to
send it. Put the same secret in **Settings → Speech-to-text → Backend token**, or
pass it as `WHISPER_BACKEND_TOKEN` to the SubSmelt container; otherwise every
health, model and transcription request comes back `401`.

```yaml
services:
  subsmelt:
    environment:
      - WHISPER_BACKEND_TOKEN=${WHISPER_TOKEN}
  whisper-backend:
    environment:
      - SUBSMELT_WHISPER_TOKEN=${WHISPER_TOKEN}
```

API keys are stored in `config.json` and are redacted from API responses, but
that file is plaintext on disk — back it up somewhere private.

---

## Volumes

| Mount | Purpose |
|-------|---------|
| `/app/config` | `config.json` — all settings and translation tasks. **Back this up.** |
| `/app/data` | SQLite DB and log files. Safe to delete if the queue gets stuck. |
| `/media` | Your video and subtitle files (read/write). |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | `UTC` | Timezone for log timestamps |
| `PORT` | `3000` | Web server port |
| `DATA_DIR` | `/app/data` | SQLite database and log files |
| `CONFIG_DIR` | `/app/config` | config.json location |
| `MEDIA_DIR` | `/media` | Root directory to scan |
| `LLM_ENDPOINT` | — | Override LLM endpoint on startup |
| `API_KEY` | — | Override API key on startup |
| `MODEL` | — | Override model name on startup |
| `WHISPER_BACKEND_URL` | — | Optional speech-to-text backend URL |
| `WHISPER_BACKEND_TOKEN` | — | Shared secret for the STT backend — must match its `SUBSMELT_WHISPER_TOKEN` |
| `WHISPER_TRANSPORT` | `auto` | `shared` (backend reads `/media` directly) or `upload` |

---

## Building from Source

```bash
git clone https://github.com/azuma24/subsmelt
cd subsmelt
docker compose up -d
```

Or manually:

```bash
docker build -t subsmelt:latest .
docker run -d \
  --name subsmelt \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ./config:/app/config \
  -v ./data:/app/data \
  -v /path/to/media:/media \
  -e TZ=Asia/Taipei \
  subsmelt:latest
```

For a specific platform on Apple Silicon:

```bash
docker buildx build --platform linux/amd64 -t subsmelt:latest .
```

---

## Development

```bash
npm ci --legacy-peer-deps   # see note below
npm run dev          # API (tsx watch) + Vite dev server
npm test             # node:test across src/**/*.test.ts(x)
npm run typecheck    # client AND server TypeScript projects
npm run build        # typecheck, then vite build, then tsc for the server
```

The Python sidecar has its own suite, which must be run from its directory:

```bash
cd backend-whisper
pip install -r requirements.txt pytest
python -m pytest tests -q
```

`--legacy-peer-deps` is required: `i18next@26` declares an optional TypeScript
peer of `^5 || ^6` while this repo is on TypeScript 7, which the npm bundled with
Node 22 rejects outright. The Dockerfile and CI use the same flag.

`vite build` does not typecheck — run `npm run typecheck` before assuming a
change is clean. CI runs both suites, both typechecks, the production build and a
Docker image build on every pull request, and the release workflows depend on
those checks passing.

New to the codebase? Start with **[docs/HANDOFF.md](docs/HANDOFF.md)** — layout,
the parts worth understanding first, the release process, and the known gaps.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 LTS (engines: >=20 <25) |
| Backend | Express, better-sqlite3 |
| Frontend | React 18, Vite, Tailwind CSS |
| Real-time | Server-Sent Events |
| Translation | Vercel AI SDK (local + OpenAI / Anthropic / Gemini) |
| Optional STT | Python FastAPI sidecar + faster-whisper |
| File watch | chokidar |
| i18n | i18next (32 locales) |
| Container | Single Dockerfile, no external services required |

---

## Credits

Translation engine ported from [subtitle-translator-electron](https://github.com/gnehs/subtitle-translator-electron) by gnehs (MIT License).
