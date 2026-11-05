# SubSmelt

**Self-hosted subtitle translator for your media library.**

Point SubSmelt at your media folders and it translates every subtitle file into
any number of languages, with an LLM on your own hardware or a cloud API key.
Nothing leaves your network unless you choose a cloud provider.

Current release: **0.8.2** · [Changelog](CHANGELOG.md) ·
[Downloads](https://github.com/azuma24/subsmelt/releases)

## Quick start

```yaml
services:
  subsmelt:
    image: ghcr.io/azuma24/subsmelt:latest   # or pin: ghcr.io/azuma24/subsmelt:0.8.2
    container_name: subsmelt
    ports:
      - "3000:3000"
    volumes:
      - ./config:/app/config
      - ./data:/app/data
      - /path/to/media:/media
    environment:
      - TZ=America/New_York
    restart: unless-stopped
```

Start it with `docker compose up -d` and open `http://YOUR-HOST:3000`. Mount as
many media folders under `/media` as you like; SubSmelt scans it recursively.

## Using it

1. **Settings → LLM Connection**: add a local endpoint (LM Studio, Ollama,
   vLLM, GPUStack) or an OpenAI, Anthropic or Gemini key. With several
   connections, choose single, fallback or parallel. For a local model, load it
   with a context length of 16k or more.
2. **Settings → Languages**: add your target languages. Each subtitle produces
   one file per language, named with a three-letter code (`Movie.chi.srt`).
3. **Library → Scan**: the **Jobs** view lists every translation job and the
   work not started yet; **Files** shows one row per video with a chip for each
   language. Click a file to translate, retry or transcribe it.
4. Turn on the **File Watcher** in Settings to queue new subtitles as they appear.

Also built in: **Corrections** for terms that keep coming out wrong, such as a
brand Whisper mishears, fixed before and after translation in the folders you
choose ([docs/subtitle-corrections.md](docs/subtitle-corrections.md)), the **Convert** page for single files (`.srt`, `.vtt`, `.ass`,
`.ssa`), **YouTube** playlists saved as Markdown notes
([second-brain mirror](docs/second-brain.md)), token usage and cost in
**Settings → Usage**, and 10 interface languages. Why an LLM instead of a
translation engine: [docs/why-llm-translation.md](docs/why-llm-translation.md).

## Speech to text (optional)

Videos with no subtitles can be transcribed by a Whisper backend: faster-whisper,
NVIDIA Nemotron, and whisper.cpp on a Mac. Download models from **Settings →
Speech-to-text models**, then set **Backend URL** and **Backend token** on the
same page.

| Where it runs | How |
|---|---|
| Windows PC (NVIDIA GPU or CPU) | `SubSmeltWhisperBackend-Setup-<version>.exe` from [Releases](https://github.com/azuma24/subsmelt/releases). Runs as you, starts at sign-in, no admin prompts. [Details](backend-whisper/packaging/windows/README.md) |
| Mac (Apple Silicon) | `subsmelt-whisper-macos-arm64-<version>.zip` from [Releases](https://github.com/azuma24/subsmelt/releases). [Details](backend-whisper/packaging/macos/README.md) |
| Docker, beside SubSmelt | `docker compose -f docker-compose.yml -f docker-compose.whisper.yml up -d` (add `-f docker-compose.whisper.gpu.yml` for an NVIDIA GPU), then use `http://whisper-backend:8001` |

## Security

- **SubSmelt has no login and listens on all interfaces.** Keep it on a trusted
  network, or put it behind a reverse proxy with authentication.
- **Give the Whisper backend a token** if anything you don't control can reach
  it. Generate one with **Generate** in the backend's control window (or
  `run_server --generate-token`), and enter the same value in SubSmelt.
- API keys live in plaintext in `config/config.json`; back it up somewhere private.

## Configuration

| Mount / variable | Default | Purpose |
|---|---|---|
| `/app/config` (`CONFIG_DIR`) | `/app/config` | `config.json`: all settings. Back it up. |
| `/app/data` (`DATA_DIR`) | `/app/data` | Database, logs, queued work |
| `/media` (`MEDIA_DIR`) | `/media` | Your videos and subtitles (read/write) |
| `TZ` | `UTC` | Timezone for logs |
| `PUID` / `PGID` | root | Run as this user so `config/` and `data/` stay editable on the host |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Web server port and bind address |
| `LLM_ENDPOINT`, `API_KEY`, `MODEL` | none | Set the LLM at startup |
| `WHISPER_BACKEND_URL`, `WHISPER_BACKEND_TOKEN` | none | Set the speech-to-text backend at startup |
| `WHISPER_TRANSPORT` | `auto` | `shared` (backend reads `/media` itself) or `upload` |

Values set by environment variables override the web UI and are never written to `config.json`.

## Development

```bash
npm ci
npm run dev        # API and Vite dev server
npm run lint       # Biome, then both typechecks
npm test
```

The Whisper backend is Python, in `backend-whisper/`: run
`python -m pytest tests -q` and `ruff check .` there. CI runs both suites and
builds the Docker image for amd64 and arm64. New to the code? Start with
[docs/HANDOFF.md](docs/HANDOFF.md); releases follow
[docs/RELEASING.md](docs/RELEASING.md).

Stack: Node.js 22, Express 5, SQLite, React 19, Vite, Tailwind CSS 4, the Vercel
AI SDK, and a Python FastAPI backend for speech to text.

## Credits

Translation engine ported from
[subtitle-translator-electron](https://github.com/gnehs/subtitle-translator-electron)
by gnehs (MIT License).
