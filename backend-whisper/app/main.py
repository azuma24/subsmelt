from __future__ import annotations

import asyncio
import json
import os
import secrets
from pathlib import Path
from typing import AsyncIterator

import shutil
import tempfile

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ValidationError

from .gpu import cuda_device_count, gpu_info, total_free_vram_mb
from .model_cache import describe_model_cache
from .model_manager import (
    ModelNotDownloadedError,
    UnknownModelError,
    assert_model_downloaded,
    delete_model,
    describe_models,
    download_model_events,
    normalize_model,
)
from .preflight import (
    assert_path_under_media,
    available_ram_mb,
    disk_free_mb,
    evaluate_disk_safety,
    evaluate_gpu_safety,
    evaluate_model_safety,
    ffmpeg_available,
    total_ram_mb,
)
from .schemas import (
    HealthResponse,
    PreflightResponse,
    TranscribeRequest,
    TranscribeResponse,
    UploadTranscribeResponse,
)
from .version import TRANSPORT_MODES, backend_version
from .model_loader import (
    CudaOutOfMemoryError,
    CudaUnavailableError,
    InvalidComputeTypeError,
    ModelWeightsMissingError,
)
from .transcribe import (
    TranscriptionCancelled,
    fake_transcribe_for_tests,
    fake_transcribe_streaming_for_tests,
    fake_transcribe_upload_for_tests,
    fake_transcribe_upload_streaming_for_tests,
    run_faster_whisper,
    run_faster_whisper_streaming,
    run_faster_whisper_upload,
    run_faster_whisper_upload_streaming,
)

MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "/media")
ALLOW_UNSAFE = os.environ.get("SUBSMELT_WHISPER_ALLOW_UNSAFE", "0") == "1"
USE_FAKE_TRANSCRIBE = os.environ.get("SUBSMELT_WHISPER_FAKE", "0") == "1"

app = FastAPI(title="Subsmelt Whisper Backend", version=backend_version())


def _configured_token() -> str:
    """The shared-secret token, read from the environment at request time.

    Read live (not cached at import) so tests and the launcher can set/unset
    ``SUBSMELT_WHISPER_TOKEN`` per process without re-importing the module. An
    empty/unset value means auth is DISABLED (the localhost dev default).
    """
    return (os.environ.get("SUBSMELT_WHISPER_TOKEN") or "").strip()


def auth_required() -> bool:
    """True when a non-empty shared-secret token is configured."""
    return bool(_configured_token())


def require_token(
    authorization: str | None = Header(default=None),
    x_subsmelt_token: str | None = Header(default=None, alias="X-Subsmelt-Token"),
) -> None:
    """FastAPI dependency enforcing the optional shared-secret token (Phase 1).

    When no token is configured, this is a no-op so localhost dev keeps working
    exactly as before. When a token IS configured, the request must present it
    via ``Authorization: Bearer <token>`` or ``X-Subsmelt-Token: <token>``;
    a missing or mismatched token yields 401. The comparison uses
    ``secrets.compare_digest`` so it is constant-time and not vulnerable to
    timing attacks.
    """
    expected = _configured_token()
    if not expected:
        return  # Auth disabled.

    presented = ""
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            presented = value.strip()
    if not presented and x_subsmelt_token:
        presented = x_subsmelt_token.strip()

    if not presented or not secrets.compare_digest(presented, expected):
        raise HTTPException(
            status_code=401,
            detail={"code": "unauthorized", "message": "Invalid or missing whisper backend token"},
        )


def capabilities() -> dict:
    """Advertise the backend's real capabilities, probed at request time.

    ``devices`` always includes ``cpu``; ``cuda`` is added only when CTranslate2
    reports at least one CUDA device. ``computeTypes`` gains the GPU-only
    float16 variants when CUDA is present. ``gpus`` lists detected GPUs with
    VRAM (empty on a CPU-only box). All probes degrade gracefully — never raise.
    """
    has_cuda = cuda_device_count() > 0
    devices = ["cpu"]
    compute_types = ["int8", "float32"]
    if has_cuda:
        devices.append("cuda")
        compute_types = ["int8", "float32", "float16", "int8_float16"]
    return {
        # version + transportModes (plan Phase 4/5): surfaced via /health and
        # /version so the SubSmelt readiness panel can show the server version and
        # which file transports (shared/upload) the backend supports.
        "version": backend_version(),
        "transportModes": TRANSPORT_MODES,
        # authRequired tells the client a shared-secret token must be sent on
        # the gated routes (/preflight, /transcribe, /transcribe/stream). It is
        # surfaced via /health (which stays open) so an unauthenticated
        # reachability check can still learn a token is needed.
        "authRequired": auth_required(),
        "models": ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"],
        "devices": devices,
        "computeTypes": compute_types,
        "gpus": gpu_info(),
        "outputFormats": ["srt", "vtt", "txt"],
        "vad": True,
        "advancedOptions": {
            "beamSize": True,
            "patience": True,
            "conditionOnPreviousText": True,
            "wordTimestamps": True,
            "initialPrompt": True,
            "speakerDiarization": False,
            "bgmSeparation": False,
        },
    }


@app.get("/health", response_model=HealthResponse, response_model_by_alias=True)
def health(model: str = Query(default="small")) -> HealthResponse:
    free_ram = available_ram_mb()
    return HealthResponse(
        ffmpeg=ffmpeg_available(),
        total_ram_mb=total_ram_mb(),
        available_ram_mb=free_ram,
        capabilities=capabilities(),
        model_cache=describe_model_cache(model, free_ram),
    )


@app.get("/version")
def version() -> dict:
    """Backend version + capabilities + supported transports (plan Phase 5).

    Open (no auth) like ``/health`` so a client can learn the server version and
    transport modes before presenting a token. ``capabilities`` already embeds
    ``version``/``transportModes``; they are also hoisted to the top level here
    for a stable, minimal contract.
    """
    caps = capabilities()
    return {
        "version": backend_version(),
        "transportModes": TRANSPORT_MODES,
        "capabilities": caps,
    }


@app.get("/models")
def list_models(_auth: None = Depends(require_token)) -> dict:
    """List every advertised model with cache + resource metadata.

    ``downloaded``/``cachePath`` reflect the on-disk HF cache; ``sizeMb`` is the
    real on-disk size when present, else an APPROXIMATE download estimate.
    Models are never auto-downloaded — this endpoint is read-only.
    """
    return {"models": describe_models()}


class ModelDownloadRequest(BaseModel):
    model: str


@app.post("/models/download")
async def models_download(
    request: ModelDownloadRequest,
    _auth: None = Depends(require_token),
) -> StreamingResponse:
    """USER-initiated model download, streamed as NDJSON.

    Validates the model id (400 on unknown) BEFORE the stream opens, then emits
    ``progress`` lines and a terminal ``result``/``error`` line. Idempotent: an
    already-present model yields an immediate ``result``. The blocking
    ``snapshot_download`` runs on a worker thread feeding a queue, so the event
    loop stays free (mirrors ``/transcribe/stream``).
    """
    try:
        normalize_model(request.model)
    except UnknownModelError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "unknown_model", "model": request.model, "message": str(exc)},
        ) from exc

    async def ndjson_stream() -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        gen = download_model_events(request.model)
        sentinel = object()

        def next_item():
            try:
                return next(gen)
            except StopIteration:
                return sentinel

        try:
            while True:
                item = await loop.run_in_executor(None, next_item)
                if item is sentinel:
                    break
                yield (json.dumps(item) + "\n").encode("utf-8")
        except Exception as exc:  # noqa: BLE001 - surface as a terminal error line
            yield (json.dumps({"type": "error", "error": str(exc)}) + "\n").encode("utf-8")
        finally:
            gen.close()

    return StreamingResponse(ndjson_stream(), media_type="application/x-ndjson")


@app.delete("/models/{model}")
def models_delete(model: str, _auth: None = Depends(require_token)) -> dict:
    """Delete a cached model snapshot. 400 unknown id, 404 if not present."""
    try:
        return delete_model(model)
    except UnknownModelError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "unknown_model", "model": model, "message": str(exc)},
        ) from exc
    except ModelNotDownloadedError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "model_not_downloaded", "model": exc.model},
        ) from exc


def preflight_result(request: TranscribeRequest) -> PreflightResponse:
    input_path = assert_path_under_media(request.input_path, MEDIA_ROOT)
    free_ram = available_ram_mb()
    safety = evaluate_model_safety(request.model, free_ram)
    model_cache = describe_model_cache(request.model, free_ram)
    ffmpeg_ok = ffmpeg_available()
    disk_mb = disk_free_mb(input_path.parent if input_path.exists() else Path(MEDIA_ROOT))
    input_size_mb = int(input_path.stat().st_size / 1024 / 1024) if input_path.exists() else 0
    disk_safety = evaluate_disk_safety(input_size_mb, disk_mb)

    # When the request targets CUDA, the binding constraint is VRAM, not system
    # RAM. Evaluate GPU safety against free VRAM (from gpu_info) and surface the
    # VRAM-specific fields/code; the system-RAM table is meaningless for GPU.
    on_gpu = (request.device or "cpu").strip().lower() == "cuda"
    gpu_safety = None
    detected_gpus = None
    if on_gpu:
        detected_gpus = gpu_info()
        gpu_safety = evaluate_gpu_safety(request.model, total_free_vram_mb())
        model_safe = gpu_safety["safe"]
        model_code = gpu_safety["code"]
        suggested = gpu_safety["suggested_model"]
    else:
        model_safe = safety["safe"]
        model_code = safety["code"]
        suggested = safety["suggested_model"]

    safe = bool(model_safe and ffmpeg_ok and disk_safety["safe"])
    code = (
        model_code if not model_safe
        else "ffmpeg_missing" if not ffmpeg_ok
        else disk_safety["code"] if not disk_safety["safe"]
        else "ok"
    )
    return PreflightResponse(
        ok=safe,
        safe=safe,
        code=code,
        available_ram_mb=safety["available_ram_mb"],
        required_ram_mb=safety["required_ram_mb"],
        recommended_ram_mb=safety["recommended_ram_mb"],
        suggested_model=suggested,
        ffmpeg_available=ffmpeg_ok,
        disk_available_mb=disk_mb,
        required_disk_mb=disk_safety["required_disk_mb"],
        model_cache=model_cache,
        device="cuda" if on_gpu else "cpu",
        free_vram_mb=gpu_safety["free_vram_mb"] if gpu_safety else None,
        required_vram_mb=gpu_safety["required_vram_mb"] if gpu_safety else None,
        recommended_vram_mb=gpu_safety["recommended_vram_mb"] if gpu_safety else None,
        gpus=detected_gpus,
    )


@app.post("/preflight", response_model=PreflightResponse, response_model_by_alias=True)
def preflight(request: TranscribeRequest, _auth: None = Depends(require_token)) -> PreflightResponse:
    try:
        return preflight_result(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "path_not_allowed", "message": str(exc)}) from exc


def validate_transcribe_request(request: TranscribeRequest) -> Path:
    """Shared validation for both the JSON and streaming transcribe endpoints.

    Returns the resolved input path or raises the appropriate HTTPException
    (path not allowed / preflight unsafe / input missing) so both endpoints
    surface identical error semantics.
    """
    try:
        input_path = assert_path_under_media(request.input_path, MEDIA_ROOT)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "path_not_allowed", "message": str(exc)}) from exc

    result = preflight_result(request)
    if not result.safe and not (ALLOW_UNSAFE or request.allow_unsafe):
        raise HTTPException(status_code=422, detail={
            "code": result.code,
            "message": f"Transcription preflight failed: {result.code}",
            "availableRamMb": result.available_ram_mb,
            "requiredRamMb": result.required_ram_mb,
            "suggestedModel": result.suggested_model,
        })

    if not input_path.exists():
        raise HTTPException(status_code=404, detail={"code": "input_missing", "message": "Input media file does not exist"})

    # CRITICAL: never silently auto-download. A known model that is not present
    # in the cache is refused with 409 here (first defence); loading later also
    # forces local_files_only=True (second defence) so faster-whisper cannot
    # reach the network either.
    try:
        assert_model_downloaded(request.model)
    except ModelNotDownloadedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "model_not_downloaded", "model": exc.model},
        ) from exc

    return input_path


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(request: TranscribeRequest, _auth: None = Depends(require_token)) -> TranscribeResponse:
    input_path = validate_transcribe_request(request)
    try:
        if USE_FAKE_TRANSCRIBE:
            return fake_transcribe_for_tests(input_path, request)
        return run_faster_whisper(request, input_path)
    except ModelWeightsMissingError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "model_not_downloaded", "model": exc.model},
        ) from exc
    except (CudaUnavailableError, InvalidComputeTypeError) as exc:
        raise HTTPException(status_code=400, detail={"code": "invalid_device", "message": str(exc)}) from exc
    except CudaOutOfMemoryError as exc:
        raise HTTPException(
            status_code=507,
            detail={"code": "cuda_out_of_memory", "message": str(exc), "suggestedModel": "small"},
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"code": "transcription_failed", "message": str(exc)}) from exc


@app.post("/transcribe/stream")
async def transcribe_stream(
    request: TranscribeRequest,
    http_request: Request,
    _auth: None = Depends(require_token),
) -> StreamingResponse:
    """Streaming transcription that emits NDJSON progress lines.

    Validation (path/preflight/missing) still returns regular HTTP error codes
    BEFORE the stream opens, so a 404/422 is surfaced cleanly. Once streaming,
    each line is a JSON object: ``progress`` lines while segments are processed,
    then a terminal ``result`` or ``error`` line.

    Cancellation: the blocking faster-whisper generator runs on a worker thread.
    A cooperative ``cancel_event`` is set when the client disconnects (detected
    via ``http_request.is_disconnected()``), which stops segment iteration and
    raises ``TranscriptionCancelled`` — the temp ffmpeg dir is cleaned up by the
    generator's context manager either way.
    """
    input_path = validate_transcribe_request(request)

    cancel_event = asyncio.Event()

    def is_cancelled() -> bool:
        return cancel_event.is_set()

    def build_generator():
        if USE_FAKE_TRANSCRIBE:
            return fake_transcribe_streaming_for_tests(input_path, request, is_cancelled)
        return run_faster_whisper_streaming(request, input_path, is_cancelled)

    async def ndjson_stream() -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        gen = build_generator()

        async def watch_disconnect() -> None:
            try:
                while not cancel_event.is_set():
                    if await http_request.is_disconnected():
                        cancel_event.set()
                        return
                    await asyncio.sleep(0.5)
            except asyncio.CancelledError:  # pragma: no cover - shutdown path
                pass

        watcher = asyncio.create_task(watch_disconnect())
        sentinel = object()

        def next_item():
            try:
                return next(gen)
            except StopIteration:
                return sentinel

        try:
            while True:
                # Run each blocking generator step on a worker thread so the
                # event loop stays free to detect client disconnects.
                item = await loop.run_in_executor(None, next_item)
                if item is sentinel:
                    break
                yield (json.dumps(item) + "\n").encode("utf-8")
        except TranscriptionCancelled:
            # Client went away; generator already cleaned up. Nothing left to send.
            return
        except Exception as exc:  # noqa: BLE001 - surface as a terminal error line
            yield (json.dumps({"type": "error", "error": str(exc)}) + "\n").encode("utf-8")
        finally:
            cancel_event.set()
            watcher.cancel()
            gen.close()

    return StreamingResponse(ndjson_stream(), media_type="application/x-ndjson")


# ===========================================================================
# Upload transport (Model B, plan Phase 2)
#
# The client uploads the media bytes (multipart) instead of pointing at a shared
# path; the server transcribes from a temp file and returns the subtitle CONTENT
# (string), never a server-side path. No shared filesystem required — true remote.
# ===========================================================================


def parse_upload_request(request_json: str, input_path: str) -> TranscribeRequest:
    """Build a TranscribeRequest from the multipart ``request`` JSON field.

    The upload protocol omits ``input_path`` (the client has no server path), so
    we inject the saved temp path. Bad JSON or schema violations become 400 so
    the client gets a clean error before any heavy work starts.
    """
    try:
        data = json.loads(request_json)
        if not isinstance(data, dict):
            raise ValueError("request must be a JSON object")
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "bad_request", "message": f"Invalid request JSON: {exc}"},
        ) from exc
    data["input_path"] = input_path
    try:
        return TranscribeRequest(**data)
    except ValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "bad_request", "message": "Invalid transcribe request", "errors": exc.errors()},
        ) from exc


def validate_upload_request(request: TranscribeRequest, upload_size_mb: int, scratch_dir: Path) -> None:
    """Resource/preflight gate for upload mode (no path-under-media check).

    Mirrors :func:`validate_transcribe_request` minus the shared-path checks:
    verifies ffmpeg, model RAM/VRAM safety, disk headroom for the upload + output,
    and that the model is already downloaded (409, never auto-download). Raises the
    same HTTP error codes so the client handles upload and path mode identically.
    """
    ffmpeg_ok = ffmpeg_available()
    on_gpu = (request.device or "cpu").strip().lower() == "cuda"
    if on_gpu:
        gpu_safety = evaluate_gpu_safety(request.model, total_free_vram_mb())
        model_safe, model_code, suggested = gpu_safety["safe"], gpu_safety["code"], gpu_safety["suggested_model"]
        avail_ram = total_free_vram_mb() or 0
        req_ram = gpu_safety["required_vram_mb"]
    else:
        safety = evaluate_model_safety(request.model, available_ram_mb())
        model_safe, model_code, suggested = safety["safe"], safety["code"], safety["suggested_model"]
        avail_ram = safety["available_ram_mb"]
        req_ram = safety["required_ram_mb"]

    disk_safety = evaluate_disk_safety(upload_size_mb, disk_free_mb(scratch_dir))
    safe = bool(model_safe and ffmpeg_ok and disk_safety["safe"])
    code = (
        model_code if not model_safe
        else "ffmpeg_missing" if not ffmpeg_ok
        else disk_safety["code"] if not disk_safety["safe"]
        else "ok"
    )

    if not safe and not (ALLOW_UNSAFE or request.allow_unsafe):
        raise HTTPException(status_code=422, detail={
            "code": code,
            "message": f"Transcription preflight failed: {code}",
            "availableRamMb": avail_ram,
            "requiredRamMb": req_ram,
            "suggestedModel": suggested,
        })

    try:
        assert_model_downloaded(request.model)
    except ModelNotDownloadedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "model_not_downloaded", "model": exc.model},
        ) from exc


def _save_upload(file: UploadFile, dest_dir: Path) -> Path:
    """Persist the uploaded stream to a real temp file ffmpeg can read."""
    filename = Path(file.filename or "upload.bin").name or "upload.bin"
    dest = dest_dir / filename
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    return dest


def _map_upload_transcription_error(exc: Exception) -> HTTPException:
    """Translate a transcription exception to the upload endpoint's HTTP error."""
    if isinstance(exc, ModelWeightsMissingError):
        return HTTPException(status_code=409, detail={"code": "model_not_downloaded", "model": exc.model})
    if isinstance(exc, (CudaUnavailableError, InvalidComputeTypeError)):
        return HTTPException(status_code=400, detail={"code": "invalid_device", "message": str(exc)})
    if isinstance(exc, CudaOutOfMemoryError):
        return HTTPException(
            status_code=507,
            detail={"code": "cuda_out_of_memory", "message": str(exc), "suggestedModel": "small"},
        )
    return HTTPException(status_code=500, detail={"code": "transcription_failed", "message": str(exc)})


@app.post("/transcribe/upload", response_model=UploadTranscribeResponse)
def transcribe_upload(
    file: UploadFile = File(...),
    request: str = Form(...),
    _auth: None = Depends(require_token),
) -> UploadTranscribeResponse:
    """Upload transport (Model B): transcribe uploaded media, return content."""
    with tempfile.TemporaryDirectory(prefix="subsmelt-upload-") as tmp:
        tmp_dir = Path(tmp)
        saved = _save_upload(file, tmp_dir)
        upload_size_mb = int(saved.stat().st_size / 1024 / 1024)
        parsed = parse_upload_request(request, str(saved))
        validate_upload_request(parsed, upload_size_mb, tmp_dir)
        try:
            if USE_FAKE_TRANSCRIBE:
                result = fake_transcribe_upload_for_tests(saved, parsed)
            else:
                result = run_faster_whisper_upload(parsed, saved)
        except Exception as exc:  # noqa: BLE001 - mapped to typed HTTP errors
            raise _map_upload_transcription_error(exc) from exc
        return UploadTranscribeResponse(**result)


@app.post("/transcribe/upload/stream")
async def transcribe_upload_stream(
    http_request: Request,
    file: UploadFile = File(...),
    request: str = Form(...),
    _auth: None = Depends(require_token),
) -> StreamingResponse:
    """Streaming upload transport: NDJSON progress then a terminal content result.

    Validation (400/409/422) happens BEFORE the stream opens. The uploaded media
    is saved to a temp dir that is removed when the stream finishes — including on
    client disconnect (cooperative cancel, mirroring ``/transcribe/stream``).
    """
    tmp_ctx = tempfile.TemporaryDirectory(prefix="subsmelt-upload-")
    tmp_dir = Path(tmp_ctx.name)
    try:
        saved = _save_upload(file, tmp_dir)
        upload_size_mb = int(saved.stat().st_size / 1024 / 1024)
        parsed = parse_upload_request(request, str(saved))
        validate_upload_request(parsed, upload_size_mb, tmp_dir)
    except BaseException:
        tmp_ctx.cleanup()
        raise

    cancel_event = asyncio.Event()

    def is_cancelled() -> bool:
        return cancel_event.is_set()

    def build_generator():
        if USE_FAKE_TRANSCRIBE:
            return fake_transcribe_upload_streaming_for_tests(saved, parsed, is_cancelled)
        return run_faster_whisper_upload_streaming(parsed, saved, is_cancelled)

    async def ndjson_stream() -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        gen = build_generator()

        async def watch_disconnect() -> None:
            try:
                while not cancel_event.is_set():
                    if await http_request.is_disconnected():
                        cancel_event.set()
                        return
                    await asyncio.sleep(0.5)
            except asyncio.CancelledError:  # pragma: no cover - shutdown path
                pass

        watcher = asyncio.create_task(watch_disconnect())
        sentinel = object()

        def next_item():
            try:
                return next(gen)
            except StopIteration:
                return sentinel

        try:
            while True:
                item = await loop.run_in_executor(None, next_item)
                if item is sentinel:
                    break
                yield (json.dumps(item) + "\n").encode("utf-8")
        except TranscriptionCancelled:
            return
        except Exception as exc:  # noqa: BLE001 - surface as a terminal error line
            yield (json.dumps({"type": "error", "error": str(exc)}) + "\n").encode("utf-8")
        finally:
            cancel_event.set()
            watcher.cancel()
            gen.close()
            tmp_ctx.cleanup()

    return StreamingResponse(ndjson_stream(), media_type="application/x-ndjson")
