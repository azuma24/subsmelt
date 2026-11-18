# Optional Subsmelt faster-whisper backend

Subsmelt can connect to any compatible speech-to-text backend URL. This directory provides an optional local faster-whisper backend for users who want Subsmelt to run transcription from the same repo.

## Run with Docker Compose

Use the optional compose overlay from the repo root:

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml up -d
```

Then open Subsmelt → Settings → Speech-to-text and set:

```text
Backend URL: http://whisper-backend:8001
Model: small
Device: cpu
Compute type: int8
Use VAD: on
```

The overlay keeps port 8001 private to the Compose network. Subsmelt uses the internal service address above; the host does not need a published backend port.

## Publish a backend endpoint explicitly

For host access, create `docker-compose.whisper.external.yml` at the repository root:

```yaml
services:
  subsmelt:
    environment:
      WHISPER_BACKEND_TOKEN_FILE: /run/secrets/whisper-token
    secrets:
      - whisper-token
  whisper-backend:
    ports:
      - "127.0.0.1:8001:8001"
    environment:
      SUBSMELT_WHISPER_TOKEN_FILE: /run/secrets/whisper-token
    secrets:
      - whisper-token
secrets:
  whisper-token:
    file: ./whisper-token
```

Create `whisper-token` with one random credential, restrict its permissions, and keep it out of version control. See [mounted secrets](../docs/mounted-secrets.md) for file requirements and precedence. Both containers must be able to read the secret.

Start the services with the additional overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml -f docker-compose.whisper.external.yml up -d
```

For LAN access, replace `127.0.0.1` in the port mapping with the host's intended LAN address. External clients send `Authorization: Bearer <token>` or `X-Subsmelt-Token: <token>` on protected endpoints. Use an HTTPS reverse proxy when the network is not trusted. `/health` and `/version` remain public for discovery. Direct installations can use `SUBSMELT_WHISPER_TOKEN` and Subsmelt's `WHISPER_BACKEND_TOKEN` instead of mounted files.

## Request limits

One transcription may be active per backend process by default. Shared-file, upload, and URL requests use the same admission limit, including streaming and nonstreaming requests. Uploads reserve a slot before multipart parsing; URL requests reserve it before downloading media. A disconnected request retains its slot until its worker closes the model generator and removes temporary files.

A full backend immediately returns HTTP 503, a `Retry-After: 5` header, and this JSON body:

```json
{"detail":{"code":"backend_busy","message":"Whisper backend is busy; retry after the current transcription finishes"}}
```

There is no backend waiting queue. Clients can retry after the indicated delay. Health, preflight, and model management remain available while transcription is busy.

| Backend environment variable | Default | Meaning |
| --- | --- | --- |
| `SUBSMELT_WHISPER_MAX_ACTIVE_TRANSCRIPTIONS` | `1` | Concurrent accepted transcription requests, including receiving uploads and worker cleanup |
| `SUBSMELT_WHISPER_BUSY_RETRY_AFTER_SECONDS` | `5` | Retry hint when all slots are occupied |
| `SUBSMELT_WHISPER_MAX_JSON_BYTES` | `1048576` | Raw body limit for protected JSON endpoints |
| `SUBSMELT_WHISPER_MAX_UPLOAD_MB` | `5120` | Multipart request limit in MiB, including encoding overhead |

All limits must be positive integers; invalid values stop startup with the variable name. Keep a single server process for a single GPU: each additional worker process has its own admission limit and model cache. Increase concurrency only when the host has capacity for simultaneous jobs.

Authentication checks run before reading protected bodies. Both declared and chunked bodies are bounded. Oversized JSON returns HTTP 413 with `detail.code: "json_too_large"`; oversized multipart returns `"upload_too_large"`. Streaming workers buffer at most 16 queued events and one pending event, then wait for the client. Progress, result, and error events retain their order; a disconnect unblocks the producer.

## Important path rule

The backend must see the same media paths that Subsmelt sees. If Subsmelt scans `/media/anime/Episode 01.mkv`, this backend must also be able to read `/media/anime/Episode 01.mkv`.

## Endpoints

- `GET /health` — readiness, capabilities, RAM, ffmpeg status, and selected-model cache hints.
- `POST /preflight` — RAM/ffmpeg/disk/path safety check plus selected-model cache hints.
- `POST /transcribe` — generate `.srt`, `.vtt`, or `.txt` next to the media file.

## Recognition checkpoints

The backend saves raw recognition output, including detected language and available word timings, before diarization and subtitle rendering. A retry with the same input revision and recognition options can reuse it, even when the subtitle format changes. Requests can set `force_recognition: true` to rerun the recognizer.

Checkpoints live in `subsmelt-transcripts` under the model cache. Set `SUBSMELT_WHISPER_CHECKPOINT_DIR` to use a different directory, or `SUBSMELT_WHISPER_CHECKPOINTS=0` to disable them. The backend ignores entries over 30 days old and prunes on write to at most 128 entries and 256 MiB. Keep this directory on the backend when restarting or upgrading it.

Set `audio_stream_index` to the absolute FFprobe stream index to select a particular audio track. The backend preserves its offset relative to the media start. Subsmelt can also prepare a lossless 16 kHz mono audio-only upload when upload transport is in use.

From the repository root, compare the same track on the same backend with each transport payload:

```bash
npx tsx scripts/benchmark-transcription.ts http://localhost:8001 /path/to/Movie.mkv --audio-stream 2 --rounds 2
```

Use `WHISPER_BACKEND_TOKEN` when the backend requires authentication. The script forces recognition in each run and reports bytes, elapsed phases, audio duration, and whether the rendered subtitles match.

## CPU defaults

Recommended first settings:

```text
model: small
compute: int8
device: cpu
vad: true
```

Use `base` on lower-memory machines. Use `medium` only when the preflight says there is enough RAM.

## Fake-backend smoke test

Use this when you want to verify the Subsmelt wiring, same-path mounts, readiness panel, and subtitle write path without downloading any faster-whisper model.

1. Keep the media mounts identical in both compose files.

```yaml
# docker-compose.yml
- /path/to/anime:/media/anime

# docker-compose.whisper.yml
- /path/to/anime:/media/anime
```

2. Start the optional backend in fake mode from the repo root.

```bash
SUBSMELT_WHISPER_FAKE=1 docker compose -f docker-compose.yml -f docker-compose.whisper.yml up -d --build
```

3. Point Subsmelt Settings → Speech-to-text to `http://whisper-backend:8001` and keep CPU defaults such as `small`, `cpu`, and `int8`.

4. Run readiness, preflight, and fake transcription inside the private backend container. Replace the media path with a real file mounted into both services. The last request writes a short subtitle beside that file.

```bash
docker compose -f docker-compose.yml -f docker-compose.whisper.yml exec -T whisper-backend python - <<'PYTHON'
import json
from urllib.request import Request, urlopen
from app.secret_file import secret_from_env

payload = {
    "input_path": "/media/anime/Episode 01.mkv",
    "output_format": "srt",
    "model": "small",
    "language": "auto",
    "device": "cpu",
    "compute_type": "int8",
    "use_vad": True,
}
headers = {"Content-Type": "application/json"}
token = secret_from_env("SUBSMELT_WHISPER_TOKEN")
if token:
    headers["Authorization"] = f"Bearer {token}"
for endpoint in ("/health?model=small", "/preflight", "/transcribe"):
    body = None if endpoint.startswith("/health") else json.dumps(payload).encode()
    request = Request("http://127.0.0.1:8001" + endpoint, data=body, headers=headers)
    with urlopen(request) as response:
        print(endpoint, response.status, response.read().decode())
PYTHON
```

The fake backend only verifies plumbing. Real inference still requires the faster-whisper runtime and model weights.
