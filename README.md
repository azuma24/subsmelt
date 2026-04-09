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
- **Multi-language UI** — Interface available in English, 繁體中文, 简体中文, and 日本語
- **Single container** — No external services, no database server; just one Docker image

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

### 3. Add target languages

Open **Languages**. Use the quick-add presets (繁中, 日本語, 한국어, etc.) or create custom tasks. Each task defines:

- Source language (e.g. English)
- Target language (e.g. Traditional Chinese (Taiwan))
- Output filename pattern (e.g. `{{name}}.chi.srt`)

One subtitle file generates one output file per language task automatically.

### 4. Scan and translate

On the **Dashboard**, click **Scan Folders**. The file tree shows every video, its subtitles, and the translation status per language. Click **Run All** to start.

### 5. Automate it

Enable the **File Watcher** in Settings. New subtitle files are detected and queued within seconds — no manual scanning needed.

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

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 LTS |
| Backend | Express, better-sqlite3 |
| Frontend | React 18, Vite, Tailwind CSS |
| Real-time | Server-Sent Events |
| Translation | Vercel AI SDK |
| File watch | chokidar |
| i18n | i18next |
| Container | Single Dockerfile, no external services |

---

## Credits

Translation engine ported from [subtitle-translator-electron](https://github.com/gnehs/subtitle-translator-electron) by gnehs (MIT License).
