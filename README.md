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
- **Local or cloud LLM** — LM Studio, Ollama, vLLM or GPUStack on your own hardware, or OpenAI, Anthropic and Google Gemini with an API key
- **Context-aware chunking** — 20-line chunks with a 5-line overlap, plus a glossary pre-pass on longer files that keeps names and terms consistent
- **Adaptive parallelism** — probes the model's real context window, then auto-tunes chunk count and worker count
- **Batch and automatic** — scans your whole library (recursive, root-only or hand-picked subfolders), and a file watcher queues new subtitles within seconds of them appearing
- **Queue management** — priority pinning, force re-translate, graceful stop, already-translated detection, and resume on restart
- **Crash safety** — work in progress goes to a `.part` file and is only renamed on completion, so an interrupted job is retried rather than left truncated
- **Real-time progress** — live job progress over Server-Sent Events with time remaining and throughput, and failures mapped to a cause and a next step
- **Subtitle preview** — side-by-side original vs translated with full-text search
- **Optional speech-to-text** — attach a faster-whisper backend to generate source subtitles when none exist
- **Formats** — `.srt`, `.vtt`, `.ass`, `.ssa` · **UI** — 32 locales

---

## How It Works

### 1. Configure your LLM

Open **Settings → LLM Connection**. Four tabs:

| Tab | Use case |
|-----|----------|
| **Local** | Self-hosted endpoint — LM Studio, Ollama, vLLM, GPUStack |
| **OpenAI** | Enter your `sk-...` key, pick `gpt-4o` or `gpt-4.1-mini` |
| **Anthropic** | Enter your `sk-ant-...` key, pick Claude Sonnet or Haiku |
| **Gemini** | Enter your `AIza...` key, pick `gemini-2.5-flash` or `gemini-2.5-pro` |

Each provider stores its key and model independently — switching tabs doesn't lose your settings for the others.

For local endpoints, click **↻ Fetch models** to pull the model list, then **Test Connection** to verify.

### 2. Add translation targets

Open **Translations**. Use quick-add presets or define custom targets — source language, target language, output filename pattern (e.g. `{{name}}.chi.srt`). One input file generates one output file per enabled task.

### 3. Scan and translate

**Dashboard → Scan Folders**, then **Run All**. The file tree shows every video, its subtitles, and translation status per language.

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

API keys are stored in `config.json` and are redacted from API responses, but
that file is plaintext on disk — back it up somewhere private.

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
| `PORT` | `3000` | Web server port |
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
docker compose up -d      # or: npm ci --legacy-peer-deps && npm run dev
```

```bash
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

`npm ci` needs `--legacy-peer-deps` (an `i18next` peer-range conflict — the
reason is in HANDOFF). `vite build` does not typecheck, so run `npm run
typecheck` before assuming a change is clean. CI runs both suites, both
typechecks, the production build and a Docker image build on every pull request.

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
