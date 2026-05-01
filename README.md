# SubSmelt

**Self-hosted subtitle translator for your media library.**

Point SubSmelt at your media folders and it automatically translates every subtitle file into multiple target languages using any OpenAI-compatible LLM — running entirely on your own hardware, no cloud required.

One subtitle file. Multiple language outputs. Fully automated.

---

## Features

- **Multi-language output** — A single `.srt` file can generate subtitles in Traditional Chinese, Simplified Chinese, Japanese, and any other language simultaneously
- **Any OpenAI-compatible LLM** — Works with Ollama, vLLM, GPUStack, LM Studio, OpenAI, or any server that speaks the `/v1/chat/completions` API
- **Batch processing** — Scan your entire library at once; SubSmelt queues and processes every subtitle file automatically
- **Real-time progress** — Live job progress via Server-Sent Events, no page refresh needed
- **File watcher** — Drop a new subtitle into your media folder and it's auto-detected and queued within seconds
- **Scan modes** — Recursive (all subfolders), root only, or hand-pick specific subfolders to scan
- **Subtitle preview** — Side-by-side original vs translated view with full-text search and quality indicators
- **Crash recovery** — Partial saves after each chunk; interrupted jobs resume where they left off
- **Smart skipping** — Already-translated files are detected and skipped automatically
- **Queue management** — Priority pinning, force re-translate, graceful stop, resumes on restart
- **Supported formats** — `.srt`, `.vtt`, `.ass`, `.ssa`
- **Optional speech-to-text** — Connect to a faster-whisper backend to generate source subtitles when videos have none
- **Per-folder STT defaults** — Override model, language, output format, subtitle quality, and advanced options for specific folders
- **STT history and retry** — Review recent transcription attempts, retry failed jobs, and keep output paths aligned with generated subtitles
- **Multi-language UI** — Interface available in English, 繁體中文, 简体中文, and 日本語
- **Simple core container** — No database server; optional transcription runs as a separate add-on or external service

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

Replace `/share/Media Data/Media/downloads` with your actual media path. Change `TZ` to your timezone (e.g. `America/Los_Angeles`, `Europe/London`, `Asia/Tokyo`).

Then open `http://YOUR-HOST-IP:3000` and follow the onboarding checklist.

---

## How It Works

### 1. Mount your media

The app scans `/media` inside the container recursively. Mount your host folders there:

```yaml
volumes:
  - /nas/movies:/media/movies
  - /nas/anime:/media/anime
  - /nas/tv:/media/tv
```

### 2. Configure your LLM

Open **Settings** in the web UI. Choose your API type and enter your endpoint URL and model name.

| Provider | Endpoint Example |
|----------|-----------------|
| Ollama | `http://192.168.1.18:11434/v1` |
| vLLM / GPUStack | `http://192.168.1.18:8000/v1` |
| LM Studio | `http://192.168.1.25:1234/v1` |
| OpenAI | `https://api.openai.com/v1` |

Click **↻ Fetch models** to load available models, then **Test Connection** to verify.

### 3. Add translation targets

Open **Translations**. Use the quick-add presets (繁中, 日本語, 한국어, etc.) or create custom translation targets. Each target defines:

- Source language (e.g. English)
- Target language (e.g. Traditional Chinese (Taiwan))
- Output filename pattern (e.g. `{{name}}.chi.srt`)

One subtitle file generates one output file per language task automatically.

### 4. Scan and translate

On the **Dashboard**, click **Scan Folders**. The file tree shows every video, its subtitles, and the translation status per language. Click **Run All** to start.

### 5. Automate it

Enable the **File Watcher** in Settings. New subtitle files are detected and queued within seconds — no manual scanning needed.

### Optional: generate subtitles with speech-to-text

SubSmelt does not require Whisper. By default it stays lightweight and translates existing subtitle files.

If you want video/audio → source subtitle generation, point **Settings → Speech-to-text** at any compatible local transcription backend. The bundled faster-whisper add-on is optional:

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml up -d
```

Then set the backend URL in the web UI to:

```text
http://whisper-backend:8001
```

Default setup: keep media mounts identical between SubSmelt and the backend. If SubSmelt sees `/media/anime/Episode 01.mkv`, the whisper backend should read that exact same path.

Optional advanced setup: if an external/LAN/backend-whisper host mounts the same files at a different absolute prefix, leave SubSmelt’s own `MEDIA_DIR` unchanged and set **Speech-to-text → Backend path map** in Settings:

- `from`: the absolute prefix SubSmelt sees locally, such as `/media`
- `to`: the absolute prefix the backend can read, such as `/srv/media`

SubSmelt still validates the original video path under `MEDIA_DIR` first. Only the path sent to the backend is rewritten, and the mapped result must stay an absolute filesystem path.

Recommended CPU defaults are `small`, `cpu`, `int8`, VAD enabled, and max concurrency `1`. SubSmelt runs a preflight check before transcription so low-RAM systems can warn, downgrade, skip, or block safely depending on your setting.

Speech-to-text settings live in the web UI, not Docker env. You can configure:

| Setting | What it controls |
|---------|------------------|
| Model / device / compute | Faster-whisper model, CPU/GPU device, and compute type such as `int8` |
| Language / output format | Auto-detect or explicit source language, plus `.srt`, `.vtt`, or `.txt` output |
| Missing-subtitle behavior | Ask first, auto-transcribe, or auto-transcribe and queue translation |
| Low-RAM behavior | Ask, downgrade, skip, or run anyway after preflight |
| Subtitle quality | Max line length, max subtitle duration, and short-segment merging |
| Per-folder defaults | Folder-specific overrides; the longest matching folder path wins |
| Advanced STT options | Lightweight faster-whisper knobs such as beam size, patience, word timestamps, and initial prompt |

Example per-folder defaults JSON:

```json
[
  { "path": "/media/anime", "language": "ja", "model": "small", "output_format": "vtt" },
  { "path": "/media/lectures", "language": "en", "model": "medium", "advanced_options": { "beam_size": 7, "initial_prompt": "Technical lecture audio." } }
]
```

Example advanced STT options JSON:

```json
{
  "beam_size": 5,
  "patience": 1.2,
  "condition_on_previous_text": false,
  "word_timestamps": true,
  "initial_prompt": "Clear speech with occasional technical terms."
}
```

Heavy options such as speaker diarization and BGM separation are explicit capability flags. The bundled lightweight backend reports them as unsupported instead of silently pulling large extra dependencies into the core app.

Generated source subtitle names match scanner expectations: auto language writes `Movie.srt`; explicit languages write names such as `Movie.ja.vtt`. The transcription history stores the local media path so retries continue to work even when backend path mapping is enabled.

For a no-download smoke test of the optional backend wiring, run the whisper overlay with fake mode enabled:

```bash
SUBSMELT_WHISPER_FAKE=1 docker compose -f docker-compose.yml -f docker-compose.whisper.yml up -d --build
```

Keep the media mounts identical in both compose files so the backend sees the same absolute paths as SubSmelt. In fake mode, `/health`, `/preflight`, and `/transcribe` work without downloading any model weights. See [backend-whisper/README.md](./backend-whisper/README.md) for `curl` examples.

If you want an NVIDIA GPU backend, add the optional overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml -f docker-compose.whisper.gpu.yml up -d
```

After the backend is up, set the speech-to-text device in the web UI to `cuda` only if your faster-whisper image advertises CUDA support.

---

## Volumes

| Mount | Purpose |
|-------|---------|
| `/app/config` | `config.json` — all settings + translation tasks. **Back this up.** |
| `/app/data` | SQLite DB + log files. Safe to delete if queue gets stuck. |
| `/media` | Your video + subtitle files (read/write). |

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
| `WHISPER_BACKEND_URL` | — | Optional speech-to-text backend URL override; behavior settings live in the web UI |

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

Docker builds are host-native by default. On Apple Silicon, ARM hosts build ARM images; on x86 hosts they build x86 images.

If you specifically need an `linux/amd64` image from a non-x86 machine, use `buildx` explicitly instead of forcing that platform in the default compose files:

```bash
docker buildx build --platform linux/amd64 -t subsmelt:latest .
```

For the optional Whisper backend image:

```bash
docker buildx build --platform linux/amd64 -t subsmelt-whisper:latest ./backend-whisper
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 LTS |
| Backend | Express, better-sqlite3 |
| Frontend | React 18, Vite, Tailwind CSS |
| Real-time | Server-Sent Events |
| Translation | Vercel AI SDK |
| Optional STT | Python FastAPI sidecar + faster-whisper |
| File watch | chokidar |
| i18n | i18next |
| Container | Single Dockerfile, no external services |

---

## Credits

Translation engine ported from [subtitle-translator-electron](https://github.com/gnehs/subtitle-translator-electron) by gnehs (MIT License).
