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

## Important path rule

The backend must see the same media paths that Subsmelt sees. If Subsmelt scans `/media/anime/Episode 01.mkv`, this backend must also be able to read `/media/anime/Episode 01.mkv`.

## Endpoints

- `GET /health` — readiness, capabilities, RAM, ffmpeg status, and selected-model cache hints.
- `POST /preflight` — RAM/ffmpeg/disk/path safety check plus selected-model cache hints.
- `POST /transcribe` — generate `.srt`, `.vtt`, or `.txt` next to the media file.

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

4. Check readiness without any model download.

```bash
curl "http://localhost:8001/health?model=small"
```

5. Run a no-download preflight check against a real media path that is mounted into both services at the same absolute path.

```bash
curl -X POST "http://localhost:8001/preflight" \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/media/anime/Episode 01.mkv",
    "output_format": "srt",
    "model": "small",
    "language": "auto",
    "device": "cpu",
    "compute_type": "int8",
    "use_vad": true
  }'
```

6. Run a fake transcription smoke test. This writes a short subtitle file next to the media file and never downloads a model.

```bash
curl -X POST "http://localhost:8001/transcribe" \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/media/anime/Episode 01.mkv",
    "output_format": "srt",
    "model": "small",
    "language": "auto",
    "device": "cpu",
    "compute_type": "int8",
    "use_vad": true
  }'
```

The fake backend only verifies plumbing. Real inference still requires the faster-whisper runtime and model weights.
