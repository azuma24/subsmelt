# SubSmelt

**Self-hosted subtitle translator for your media library.**

Point SubSmelt at your media folders and it translates every subtitle file into
any number of languages, with an LLM on your own hardware or a cloud API key.
Nothing leaves your network unless you choose a cloud provider.

Current release: **0.9.1** · [Changelog](CHANGELOG.md) ·
[Downloads](https://github.com/azuma24/subsmelt/releases)

## Quick start

```yaml
services:
  subsmelt:
    image: ghcr.io/azuma24/subsmelt:latest   # or pin: ghcr.io/azuma24/subsmelt:0.9.1
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
4. Use **Settings → Sources & Monitoring → Library watcher** to detect new
   videos and subtitles. The watcher uses file change events, scheduled scans,
   or both. Pausing it stops both detection methods and keeps their settings.

Use **Find embedded tracks** in a Library video's panel to import a text
subtitle from MKV or MP4 as a sidecar. **Convert** can check staged files for
quality warnings. The **Jobs** preview separates subtitle warnings from
playback suggestions and reports shared timing suggestions once. It offers
bilingual SRT downloads for completed translations with matching cues.
Publishing an imported sidecar requires hard-link support on the media filesystem.
See [caption-first scans and image OCR](docs/library-subtitle-intake.md) and
[processing profiles, review, and JSON automation](docs/processing-workflows.md).
See [mounted secrets](docs/mounted-secrets.md) for deployment credentials.

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

Use **Whisper backend 0.9.0 or later** for unattended subtitle intake with a shared
media filesystem. See [Library subtitle intake](docs/library-subtitle-intake.md).

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


## Security and ingress

SubSmelt is a single-user administration service, not a multi-user security boundary.
By default it listens on all interfaces and has **no authentication**; anyone who
can connect can read library paths, logs and job data, change settings, start
work that incurs charges, and cause the service to access configured files and
backends. Settings responses redact configured secrets, but that is not a
substitute for access control. Use only on a network where every reachable
client is trusted; LAN membership alone does not make a network trustworthy.
Do not expose the default service to the internet.

Two optional environment-based controls can be enabled together (existing installs
remain unchanged until configured):

- `SUBSMELT_ALLOWED_HOSTS`: comma-separated exact HTTP Host authorities, for
  example `localhost:3000,192.168.1.10:3000,subs.example.com`. Matching is
  case-insensitive, includes the port when present, and also applies to reads,
  static files, SSE, and health checks. IPv6 uses brackets, e.g. `[::1]:3000`.
  No wildcards, schemes, paths, or forwarded host headers are accepted. A
  configured empty or malformed list prevents startup. This blocks browser DNS
  rebinding using an unlisted hostname, including same-origin GET requests;
  it does not stop a direct client forging an allowed Host or an attacker who
  controls an allowed hostname. Configure every actual access authority.
- `SUBSMELT_BASIC_USER` and `SUBSMELT_BASIC_PASSWORD`: both must be nonempty;
  the username cannot contain `:`. The server requires HTTP Basic authentication
  on every request including assets, SSE, and health checks. Partial configuration
  prevents startup. Store the values securely, never in a committed compose file;
  environment variables can be visible to host/container administrators. Basic
  credentials are only encoded, not encrypted: use HTTPS through a trusted
  reverse proxy, or an encrypted private tunnel. Do not use Basic over plain LAN
  HTTP. Authentication is shared: it does not provide accounts, roles, rate
  limiting, MFA, or protection from a compromised authenticated client.

For authenticated remote ingress, place a TLS reverse proxy with authentication
(or the optional Basic guard above) in front of SubSmelt, preserve the original
`Host` header and configure its exact public authority in the allow-list.
Bind the backend to loopback or a private container network and firewall it so
clients cannot bypass the proxy. In Docker, `HOST=127.0.0.1` inside the container
is not accessible from a separate proxy container; use a private network instead.
The proxy must overwrite untrusted forwarding headers. This does not secure the
separate Whisper backend: isolate and authenticate it independently.

The bundled Docker health check sends an unauthenticated localhost request; it
will fail if Basic is enabled or localhost is not allow-listed. Configure an
authenticated health check without putting credentials in command arguments, or
disable that container health check and monitor through a protected ingress.
Host validation and authentication intentionally do not exempt `/api/health`.
The existing cross-site request guard blocks common browser cross-origin writes,
but is not authentication and, without a configured host allow-list, cannot
prevent DNS rebinding. Non-browser clients can forge browser headers.
Scripts that use legacy `GET /api/models` should send `X-SubSmelt-Client: cli`.
Model discovery also accepts a JSON `POST /api/models` request.

Media subfolder checks reject traversal and resolve existing symlinks (including
existing ancestors of new paths); symlinks that resolve outside the media root
or are dangling are refused. This is a point-in-time check, **not** an atomic
filesystem sandbox: a local process able to replace paths/symlinks between
validation and use can redirect later operations, and other file operations and
external downloaders are not all covered by this helper. Restrict write access to
media directories to trusted users and run the service with least filesystem
privilege. Do not mount sensitive host directories into the container.
