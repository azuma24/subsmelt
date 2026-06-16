from __future__ import annotations

import asyncio
import json
import os
import secrets
from pathlib import Path
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .gpu import cuda_device_count, gpu_info, total_free_vram_mb
from .model_cache import describe_model_cache
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
from .schemas import HealthResponse, PreflightResponse, TranscribeRequest, TranscribeResponse
from .model_loader import CudaOutOfMemoryError, CudaUnavailableError, InvalidComputeTypeError
from .transcribe import (
    TranscriptionCancelled,
    fake_transcribe_for_tests,
    fake_transcribe_streaming_for_tests,
    run_faster_whisper,
    run_faster_whisper_streaming,
)

MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "/media")
ALLOW_UNSAFE = os.environ.get("SUBSMELT_WHISPER_ALLOW_UNSAFE", "0") == "1"
USE_FAKE_TRANSCRIBE = os.environ.get("SUBSMELT_WHISPER_FAKE", "0") == "1"

app = FastAPI(title="Subsmelt Whisper Backend", version="0.1.0")


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

    return input_path


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(request: TranscribeRequest, _auth: None = Depends(require_token)) -> TranscribeResponse:
    input_path = validate_transcribe_request(request)
    try:
        if USE_FAKE_TRANSCRIBE:
            return fake_transcribe_for_tests(input_path, request)
        return run_faster_whisper(request, input_path)
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
