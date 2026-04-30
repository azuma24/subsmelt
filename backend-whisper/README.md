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

- `GET /health` — readiness, capabilities, RAM and ffmpeg status.
- `POST /preflight` — RAM/ffmpeg/disk/path safety check.
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
