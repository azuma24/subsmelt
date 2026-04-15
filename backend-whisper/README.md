# subsmelt-whisper (backend-whisper)

Audio-to-text transcription backend for [subsmelt](../). Runs on a machine with an
NVIDIA GPU, exposes a small REST API, and shares the `MEDIA_DIR` filesystem path with
subsmelt (Docker volume / Windows share) so subsmelt can point at a video by path and
receive an SRT/WebVTT/txt next to it.

## Stack

- FastAPI + uvicorn
- [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (CTranslate2 / CUDA 12)
- [Silero VAD](https://github.com/snakers4/silero-vad) — optional speech-activity filter
- [`audio-separator`](https://github.com/karaokenerds/python-audio-separator) — optional
  UVR-style BGM separation
- ffmpeg (bundled on Windows, base image on Docker)

## Configuration

Runtime settings live in `config.ini` (not in any UI). Resolution order, highest wins:

1. Environment variables: `MEDIA_DIR`, `MODELS_DIR`, `HOST`, `PORT`, `API_KEY`,
   `DEVICE`, `COMPUTE_TYPE`, `LOG_LEVEL`, `MAX_CONCURRENT`.
2. `config.ini` (created on first startup if missing).
3. Built-in defaults (see `config.py`).

### First-run API key

On first startup the service generates a random `api_key` via
`secrets.token_urlsafe(32)`, persists it to `config.ini`, and logs it **once** in a
clearly delimited banner to stdout. Paste that into **subsmelt → Settings →
Transcription → API key**. To rotate:

```
subsmelt-whisper regenerate-api-key     # CLI
POST /admin/api-key/rotate              # REST (requires current key)
```

Empty `api_key` disables auth (trusted-LAN mode); startup warns loudly.

## Docker

```bash
docker compose -f docker-compose.whisper.yml up --build
docker compose -f docker-compose.whisper.yml logs whisper   # see the generated key
```

Mount your media root and models cache:
```yaml
volumes:
  - ${MEDIA_DIR}:/media:rw
  - ./models:/models:rw
  - ./whisper-config:/config:rw
```
GPU access is via `deploy.resources.reservations.devices: [{capabilities: ["gpu"]}]`
or `--gpus all`.

## Windows

Install via the Inno Setup installer produced by `scripts/build-windows.ps1`. It:

- Installs to `C:\Program Files\SubsmeltWhisper\`.
- Prompts for `MEDIA_DIR`, `MODELS_DIR`, port, bind address.
- Writes `%ProgramData%\SubsmeltWhisper\config.ini`.
- Registers a Windows Service via bundled `nssm.exe`.
- Enables the Windows long-paths registry flag.
- Final screen shows the first-run API key.

## API

See `openapi.json` at `/docs` (Swagger) once the service is running. Summary:

```
POST   /transcribe                 start a transcription job
GET    /tasks/{id}                 status + progress
DELETE /tasks/{id}                 cancel

GET    /models                     list cached + catalog for whisper and uvr
POST   /models/download            download a model (reuses task polling)
DELETE /models/{kind}/{name}       delete cached model

POST   /admin/api-key/rotate       rotate the API key (auth'd)

GET    /health                     gpu/device/cuda/paths info
```

All endpoints require `Authorization: Bearer <api_key>` unless `api_key=""`.
