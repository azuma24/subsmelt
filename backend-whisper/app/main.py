from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from pathlib import Path
from typing import AsyncIterator, Callable, Iterator

import shutil
import tempfile

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ValidationError
from starlette.concurrency import run_in_threadpool

from .gpu import cuda_device_count, gpu_info, total_free_vram_mb
from .catalog import ADVERTISED_MODELS
from .engine import EngineUnavailableError, LanguageNotSupportedError, TranscriptionCancelled
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
    DIARIZATION_RAM_MB,
    DIARIZATION_VRAM_MB,
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
from .log_state import get_log_state, log_file_path
from .model_loader import (
    CudaOutOfMemoryError,
    CudaUnavailableError,
    InvalidComputeTypeError,
    ModelWeightsMissingError,
    unload_model,
)
from .diarize import (
    DiarizationTokenMissingError,
    DiarizationUnavailableError,
    diarize_available,
)
from .fetch_url import (
    UrlFetchError,
    UrlFetchUnavailableError,
    download_url,
    url_fetch_available,
)
from .transcribe import (
    fake_transcribe_for_tests,
    fake_transcribe_streaming_for_tests,
    run_transcription,
    run_transcription_streaming,
)

MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "/media")
ALLOW_UNSAFE = os.environ.get("SUBSMELT_WHISPER_ALLOW_UNSAFE", "0") == "1"
USE_FAKE_TRANSCRIBE = os.environ.get("SUBSMELT_WHISPER_FAKE", "0") == "1"

app = FastAPI(title="Subsmelt Whisper Backend", version=backend_version())
log = logging.getLogger(__name__)


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
    if not auth_required():
        return  # Auth disabled.
    if not _token_matches(_presented_token(authorization, x_subsmelt_token)):
        raise HTTPException(
            status_code=401,
            detail={"code": "unauthorized", "message": "Invalid or missing whisper backend token"},
        )


def _presented_token(authorization: str | None, x_subsmelt_token: str | None) -> str:
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            return value.strip()
    return (x_subsmelt_token or "").strip()


def _token_matches(presented: str) -> bool:
    # Compare bytes: compare_digest raises TypeError on a non-ASCII str, which
    # would turn a bad token into a 500 instead of a 401.
    expected = _configured_token()
    return bool(presented) and secrets.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))


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
        # Single source of truth: the model-manager's advertised set. Keeping this
        # derived (not a duplicated literal) means the dropdown the frontend builds
        # from capabilities.models can never drift from what the backend manages.
        "models": list(ADVERTISED_MODELS),
        "devices": devices,
        "computeTypes": compute_types,
        "gpus": gpu_info(),
        "outputFormats": ["srt", "vtt", "txt", "ass"],
        # urlInput true only when yt-dlp is installed → frontend shows the URL box
        # only when the backend can actually fetch.
        "urlInput": url_fetch_available(),
        "vad": True,
        "advancedOptions": {
            "beamSize": True,
            "patience": True,
            "conditionOnPreviousText": True,
            "wordTimestamps": True,
            "initialPrompt": True,
            # Advertised true only when pyannote is installed AND an HF token is
            # configured, so the frontend offers the toggle only when it works.
            "speakerDiarization": diarize_available(),
            "bgmSeparation": False,
        },
    }


def _health_model_cache(model: str, free_ram: int, disclose_paths: bool) -> dict:
    """The /health model-cache block, safe for an open endpoint.

    Only advertised ids touch the filesystem (an arbitrary path would make the
    open endpoint an existence oracle), and cache paths are returned only to a
    caller that could read them anyway (see ``_is_trusted_caller``).
    """
    selected = (model or "small").strip() or "small"
    if selected.lower() not in ADVERTISED_MODELS:
        safety = evaluate_model_safety("small", free_ram)
        return {
            "model": selected,
            "cached": None,
            "cache_root": None,
            "cache_path": None,
            "first_run_download_expected": False,
            "required_ram_mb": safety["required_ram_mb"],
            "recommended_ram_mb": safety["recommended_ram_mb"],
            "suggested_model": None,
            "warning": "Selected model is not one this backend manages; cache status is unknown.",
        }
    info = dict(describe_model_cache(selected, free_ram))
    if not disclose_paths:
        info["cache_root"] = None
        info["cache_path"] = None
    return info


@app.get("/health", response_model=HealthResponse, response_model_by_alias=True)
def health(
    request: Request,
    model: str = Query(default="small"),
    authorization: str | None = Header(default=None),
    x_subsmelt_token: str | None = Header(default=None, alias="X-Subsmelt-Token"),
) -> HealthResponse:
    free_ram = available_ram_mb()
    trusted = _is_trusted_caller(request, _presented_token(authorization, x_subsmelt_token))
    return HealthResponse(
        ffmpeg=ffmpeg_available(),
        total_ram_mb=total_ram_mb(),
        available_ram_mb=free_ram,
        capabilities=capabilities(),
        model_cache=_health_model_cache(model, free_ram, disclose_paths=trusted),
        log_state=get_log_state(),
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


#: Cap on how much of the log file the tail endpoint will read off disk. The
#: handler rotates at 5 MB, so this bounds the response without truncating any
#: realistic request.
_LOG_TAIL_MAX_BYTES = 512 * 1024
_LOG_TAIL_MAX_LINES = 2000

#: Client addresses that count as local, including the IPv4-mapped IPv6 form.
_LOOPBACK_CLIENTS = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}


def _is_trusted_caller(request: Request, presented: str) -> bool:
    """The disclosure rule as a predicate: a valid token, or a local caller on a
    tokenless install. Same rule ``require_token_or_loopback`` enforces for
    ``/logs``, for endpoints that stay open but carry some data worth gating."""
    if auth_required():
        return _token_matches(presented)
    host = (request.client.host if request.client else "") or ""
    return host in _LOOPBACK_CLIENTS


def require_token_or_loopback(
    request: Request,
    _auth: None = Depends(require_token),
) -> None:
    """Stricter than ``require_token`` — for endpoints that *disclose* data.

    ``require_token`` is deliberately a no-op when no token is configured, so
    localhost development keeps working. That is defensible for endpoints that
    only act on a request, but the log tail hands back accumulated content —
    media paths, request detail, tracebacks — and ``run_server`` binds 0.0.0.0
    by default. On a tokenless install that would let any host on the network
    read the log, which is a disclosure primitive the backend did not previously
    offer.

    So: if a token is configured, the normal check applies. If it is not, the
    caller must be local. Cross-host reads always require a token.
    """
    if auth_required():
        return  # require_token already validated the presented token.
    host = (request.client.host if request.client else "") or ""
    if host in _LOOPBACK_CLIENTS:
        return
    raise HTTPException(
        status_code=403,
        detail={
            "code": "token-required",
            "message": (
                "Reading logs from another host requires a backend token. Set "
                "SUBSMELT_WHISPER_TOKEN on the backend and the matching token "
                "in SubSmelt → Settings → Speech to Text."
            ),
        },
    )


@app.get("/logs")
def logs(
    lines: int = Query(default=200, ge=1, le=_LOG_TAIL_MAX_LINES),
    _auth: None = Depends(require_token_or_loopback),
) -> dict:
    """Tail the server log so clients don't need filesystem access to the host.

    Gated by ``require_token_or_loopback``: a configured token, or a local
    caller. Not open the way /health and /version are — log lines carry media
    paths and request detail.

    Reads only the last chunk of the file rather than the whole thing — the
    rotating handler allows 5 MB per file and a caller only ever wants the end.
    Never raises for an absent or unreadable file: "no log" is a normal state
    (file logging off, or nothing written yet) and the caller gets that as data.
    """
    state = get_log_state()
    path_str = log_file_path()
    result: dict = {
        "file": path_str,
        "active": bool(state.get("active")),
        "error": state.get("error"),
        "lines": [],
    }
    if not path_str:
        return result
    try:
        path = Path(path_str)
        if not path.exists():
            result["error"] = result["error"] or "log file does not exist yet"
            return result
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > _LOG_TAIL_MAX_BYTES:
                fh.seek(size - _LOG_TAIL_MAX_BYTES)
                fh.readline()  # drop the partial line the seek landed inside
            raw = fh.read()
        text = raw.decode("utf-8", errors="replace")
        result["lines"] = text.splitlines()[-lines:]
        result["truncated"] = size > _LOG_TAIL_MAX_BYTES
    except OSError as exc:
        result["error"] = f"could not read log file: {exc}"
    return result


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


async def _ndjson_stream(
    gen: Iterator[dict],
    cancel_event: asyncio.Event,
    cleanup: Callable[[], None] | None = None,
) -> AsyncIterator[bytes]:
    """Drive a blocking event generator on a worker thread, yielding NDJSON lines.

    The worker thread owns the generator's whole lifetime: it iterates, closes it
    and runs ``cleanup`` on every exit path. The loop side only forwards items;
    when the client disconnects it sets ``cancel_event`` and leaves, and the
    generator's own ``is_cancelled`` check ends the work at its next step.
    Closing the generator from the loop while a step was executing on the thread
    raised ``ValueError: generator already executing`` and skipped cleanup.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    done = object()

    def post(item: object) -> None:
        try:
            loop.call_soon_threadsafe(queue.put_nowait, item)
        except RuntimeError:  # loop closed (server shutdown): nobody is listening
            pass

    def drive() -> None:
        try:
            for item in gen:
                post(item)
        except TranscriptionCancelled:
            pass  # client went away; nothing left to send
        except Exception as exc:  # noqa: BLE001 - surface as a terminal error line
            post({"type": "error", "error": str(exc)})
        finally:
            try:
                gen.close()
                if cleanup is not None:
                    cleanup()
            except Exception:  # noqa: BLE001 - e.g. a Windows file lock on the temp media
                log.exception("stream cleanup failed")
            finally:
                post(done)

    loop.run_in_executor(None, drive)
    try:
        while True:
            item = await queue.get()
            if item is done:
                break
            yield (json.dumps(item) + "\n").encode("utf-8")
    finally:
        cancel_event.set()


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
    loop stays free (mirrors ``/transcribe/stream``). A client disconnect does
    not abort the download; it finishes on the worker thread.
    """
    try:
        normalize_model(request.model)
    except UnknownModelError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "unknown_model", "model": request.model, "message": str(exc)},
        ) from exc

    stream = _ndjson_stream(download_model_events(request.model), asyncio.Event())
    return StreamingResponse(stream, media_type="application/x-ndjson")


@app.delete("/models/{model}")
def models_delete(model: str, _auth: None = Depends(require_token)) -> dict:
    """Delete a cached model snapshot. 400 unknown id, 404 if not present.

    A resident instance is unloaded first so its VRAM is freed and, on Windows,
    the weight files are no longer locked by the loaded model."""
    try:
        normalize_model(model)
        unload_model(model)
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
    except OSError as exc:
        # Deletion failed for real (e.g. a Windows file lock from a loaded model).
        # Surface it instead of reporting a phantom success.
        raise HTTPException(
            status_code=500,
            detail={"code": "delete_failed", "model": model, "message": str(exc)},
        ) from exc


def _preflight_code(model_safe: bool, model_code: str, ffmpeg_ok: bool, disk_safety: dict) -> str:
    """The first blocker, else the first fail-open warning (``*_unknown``), else ``ok``.

    The unknown codes ride along with ``safe=True`` so the UI can warn that a
    reading was unavailable instead of reporting a clean bill of health.
    """
    if not model_safe:
        return model_code
    if not ffmpeg_ok:
        return "ffmpeg_missing"
    if not disk_safety["safe"]:
        return disk_safety["code"]
    if model_code != "ok":
        return model_code
    return disk_safety["code"]


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
        # On GPU the binding constraint is VRAM. Surface VRAM under the generic
        # available/required/recommended fields too (not just the *VramMb ones) so
        # a client reading availableRamMb sees the resource that actually gated the
        # request instead of unrelated system RAM.
        avail_mb = gpu_safety["free_vram_mb"]
        req_mb = gpu_safety["required_vram_mb"]
        rec_mb = gpu_safety["recommended_vram_mb"]
    else:
        model_safe = safety["safe"]
        model_code = safety["code"]
        suggested = safety["suggested_model"]
        avail_mb = safety["available_ram_mb"]
        req_mb = safety["required_ram_mb"]
        rec_mb = safety["recommended_ram_mb"]

    # Diarization loads a second (pyannote) model — add its headroom to the
    # requirement so a run that would OOM mid-pass is flagged up front. An
    # unmeasured reading (avail_mb <= 0) stays fail-open, as it is for the model.
    if request.advanced_options and request.advanced_options.speaker_diarization:
        req_mb += DIARIZATION_VRAM_MB if on_gpu else DIARIZATION_RAM_MB
        if model_safe and 0 < avail_mb < req_mb:
            model_safe = False
            model_code = "insufficient_vram" if on_gpu else "insufficient_ram"

    safe = bool(model_safe and ffmpeg_ok and disk_safety["safe"])
    code = _preflight_code(model_safe, model_code, ffmpeg_ok, disk_safety)
    return PreflightResponse(
        ok=safe,
        safe=safe,
        code=code,
        available_ram_mb=avail_mb,
        required_ram_mb=req_mb,
        recommended_ram_mb=rec_mb,
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

    try:
        result = preflight_result(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "path_not_allowed", "message": str(exc)}) from exc
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
            result = fake_transcribe_for_tests(input_path, request, deliver="path")
        else:
            result = run_transcription(request, input_path, deliver="path")
    except Exception as exc:  # noqa: BLE001 - mapped to typed HTTP errors
        raise _map_transcription_error(exc) from exc
    return TranscribeResponse(**result)


@app.post("/transcribe/stream")
async def transcribe_stream(
    request: TranscribeRequest,
    _auth: None = Depends(require_token),
) -> StreamingResponse:
    """Streaming transcription that emits NDJSON progress lines.

    Validation (path/preflight/missing) still returns regular HTTP error codes
    BEFORE the stream opens, so a 404/422 is surfaced cleanly. Once streaming,
    each line is a JSON object: ``progress`` lines while segments are processed,
    then a terminal ``result`` or ``error`` line.

    Cancellation: the blocking faster-whisper generator runs on a worker thread
    (see ``_ndjson_stream``). A client disconnect sets ``cancel_event``, which
    stops segment iteration and raises ``TranscriptionCancelled``; the temp
    ffmpeg dir is cleaned up by the generator's context manager either way.
    """
    # Preflight probes disk, RAM and (on CUDA) nvidia-smi; keep it off the loop.
    input_path = await run_in_threadpool(validate_transcribe_request, request)

    cancel_event = asyncio.Event()
    if USE_FAKE_TRANSCRIBE:
        gen = fake_transcribe_streaming_for_tests(input_path, request, cancel_event.is_set, deliver="path")
    else:
        gen = run_transcription_streaming(request, input_path, cancel_event.is_set, deliver="path")
    return StreamingResponse(_ndjson_stream(gen, cancel_event), media_type="application/x-ndjson")


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
    code = _preflight_code(model_safe, model_code, ffmpeg_ok, disk_safety)

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


def _upload_basename(filename: str | None) -> str:
    """Basename of a client-supplied filename, safe to create under the temp dir.

    Clients send whatever their OS calls the file, so strip both separator
    styles here rather than trusting ``Path.name`` on the server's platform.
    """
    name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1].replace("\0", "").strip()
    if not name:
        return "upload.bin"
    if name in (".", ".."):
        raise HTTPException(
            status_code=400,
            detail={"code": "bad_request", "message": f"Unusable upload filename: {filename!r}"},
        )
    return name


def _save_upload(file: UploadFile, dest_dir: Path) -> Path:
    """Persist the uploaded stream to a real temp file ffmpeg can read."""
    dest = dest_dir / _upload_basename(file.filename)
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    return dest


def _map_transcription_error(exc: Exception) -> HTTPException:
    """Translate a transcription exception to the HTTP error every transcribe
    endpoint (path, upload, url) surfaces."""
    if isinstance(exc, ModelWeightsMissingError):
        return HTTPException(status_code=409, detail={"code": "model_not_downloaded", "model": exc.model})
    if isinstance(exc, (CudaUnavailableError, InvalidComputeTypeError)):
        return HTTPException(status_code=400, detail={"code": "invalid_device", "message": str(exc)})
    if isinstance(exc, LanguageNotSupportedError):
        return HTTPException(
            status_code=400,
            detail={"code": "language_not_supported", "message": str(exc), "model": exc.model, "language": exc.language},
        )
    if isinstance(exc, EngineUnavailableError):
        return HTTPException(
            status_code=400,
            detail={"code": "engine_unavailable", "message": str(exc), "model": exc.model},
        )
    if isinstance(exc, DiarizationTokenMissingError):
        return HTTPException(status_code=422, detail={"code": "diarization_token_missing", "message": str(exc)})
    if isinstance(exc, DiarizationUnavailableError):
        return HTTPException(status_code=400, detail={"code": "diarization_unavailable", "message": str(exc)})
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
                result = fake_transcribe_for_tests(saved, parsed, deliver="content")
            else:
                result = run_transcription(parsed, saved, deliver="content")
        except Exception as exc:  # noqa: BLE001 - mapped to typed HTTP errors
            raise _map_transcription_error(exc) from exc
        return UploadTranscribeResponse(**result)


def _upload_stream_response(saved: Path, parsed: TranscribeRequest, tmp_ctx: tempfile.TemporaryDirectory) -> StreamingResponse:
    """Stream an upload-mode transcription; ``tmp_ctx`` is removed when it ends,
    including on a client disconnect."""
    cancel_event = asyncio.Event()
    if USE_FAKE_TRANSCRIBE:
        gen = fake_transcribe_streaming_for_tests(saved, parsed, cancel_event.is_set, deliver="content")
    else:
        gen = run_transcription_streaming(parsed, saved, cancel_event.is_set, deliver="content")
    stream = _ndjson_stream(gen, cancel_event, cleanup=tmp_ctx.cleanup)
    return StreamingResponse(stream, media_type="application/x-ndjson")


@app.post("/transcribe/upload/stream")
async def transcribe_upload_stream(
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
        # Copying a multi-GB upload and the preflight probes are blocking work;
        # run them on the threadpool so the loop keeps serving other clients.
        saved = await run_in_threadpool(_save_upload, file, tmp_dir)
        upload_size_mb = int(saved.stat().st_size / 1024 / 1024)
        parsed = parse_upload_request(request, str(saved))
        await run_in_threadpool(validate_upload_request, parsed, upload_size_mb, tmp_dir)
    except BaseException:
        tmp_ctx.cleanup()
        raise
    return _upload_stream_response(saved, parsed, tmp_ctx)


@app.post("/transcribe/url/stream")
async def transcribe_url_stream(
    payload: dict,
    _auth: None = Depends(require_token),
) -> StreamingResponse:
    """Fetch remote media (YouTube etc.) via yt-dlp, then transcribe it like an
    upload. Body: {"url": "...", ...same fields as the upload `request` JSON}.

    Download + validation (400/409/422) happen BEFORE the stream opens; the temp
    dir holding the fetched media is removed when the stream finishes.
    """
    url = payload.get("url")
    if not isinstance(url, str) or not url.strip():
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "Missing 'url'"})

    tmp_ctx = tempfile.TemporaryDirectory(prefix="subsmelt-url-")
    tmp_dir = Path(tmp_ctx.name)
    try:
        try:
            # yt-dlp is blocking — run it off the event loop so this async worker
            # keeps serving health/cancel/progress while a large URL downloads.
            saved = await run_in_threadpool(download_url, url, tmp_dir)
        except UrlFetchUnavailableError as exc:
            raise HTTPException(status_code=400, detail={"code": "url_fetch_unavailable", "message": str(exc)}) from exc
        except UrlFetchError as exc:
            raise HTTPException(status_code=400, detail={"code": "url_fetch_failed", "message": str(exc)}) from exc
        size_mb = int(saved.stat().st_size / 1024 / 1024)
        request_json = json.dumps({k: v for k, v in payload.items() if k != "url"})
        parsed = parse_upload_request(request_json, str(saved))
        await run_in_threadpool(validate_upload_request, parsed, size_mb, tmp_dir)
    except BaseException:
        tmp_ctx.cleanup()
        raise
    return _upload_stream_response(saved, parsed, tmp_ctx)
