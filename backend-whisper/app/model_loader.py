from __future__ import annotations

import threading
from typing import Any

from .gpu import cuda_device_count

# Module-level cache of loaded WhisperModel instances keyed by the parameters
# that affect model identity. FastAPI runs sync handlers in a threadpool, so the
# cache must be guarded by a lock to avoid loading the same model twice (or
# corrupting the dict) under concurrent requests.
_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
_CACHE_LOCK = threading.Lock()

# Compute types CTranslate2 supports per device. float16 / int8_float16 are
# GPU-only — selecting them on CPU is a hard error, not a silent fallback.
_CPU_COMPUTE_TYPES = {"int8", "int8_float32", "float32", "auto"}
_CUDA_COMPUTE_TYPES = {"int8", "int8_float16", "int8_float32", "float16", "float32", "auto"}


class CudaUnavailableError(RuntimeError):
    """device=cuda was requested but no usable CUDA device is present."""


class InvalidComputeTypeError(RuntimeError):
    """The requested compute_type is not valid for the requested device."""


class CudaOutOfMemoryError(RuntimeError):
    """CUDA ran out of memory loading or running the model."""


class ModelWeightsMissingError(RuntimeError):
    """WhisperModel was asked to load weights that are not present locally.

    Because models are loaded with ``local_files_only=True`` (no silent network
    fetch), a missing/uncached model surfaces as a local-file lookup failure.
    The API layer maps this to HTTP 409 ``model_not_downloaded``.
    """

    def __init__(self, model: str) -> None:
        super().__init__(
            f"Model {model!r} weights are not present locally and auto-download is "
            f"disabled; download the model first"
        )
        self.model = model


def _is_missing_local_files(exc: Exception) -> bool:
    """Heuristic: did the load fail because weights were absent locally?

    With ``local_files_only=True`` huggingface_hub raises errors mentioning the
    local lookup / cache miss rather than performing a download. Match the common
    phrasings so we can map them to a clean 409 instead of a generic 500.
    """
    text = str(exc).lower()
    needles = (
        "local_files_only",
        "could not find",
        "cannot find",
        "not found in the local",
        "no such file",
        "localentrynotfound",
        "is not a local folder",
        "we couldn't connect",
        "offline",
    )
    return any(needle in text for needle in needles)


def _is_cuda_oom(exc: Exception) -> bool:
    text = str(exc).lower()
    return "out of memory" in text or "cuda_error_out_of_memory" in text or "cublas" in text and "alloc" in text


def validate_device_and_compute_type(device: str, compute_type: str) -> None:
    """Validate the device/compute_type pairing before loading a model.

    Raises :class:`CudaUnavailableError` when CUDA is requested but absent, and
    :class:`InvalidComputeTypeError` when the compute_type is not valid for the
    device (e.g. float16 on CPU).
    """
    normalized_device = (device or "cpu").strip().lower()
    normalized_compute = (compute_type or "").strip().lower()

    if normalized_device == "cuda":
        if cuda_device_count() <= 0:
            raise CudaUnavailableError(
                "CUDA requested but no CUDA device available; install/upgrade the "
                "NVIDIA driver or use device=cpu"
            )
        if normalized_compute and normalized_compute not in _CUDA_COMPUTE_TYPES:
            raise InvalidComputeTypeError(
                f"compute_type={compute_type!r} is not valid for device=cuda; "
                f"use one of {sorted(_CUDA_COMPUTE_TYPES)}"
            )
    elif normalized_device == "cpu":
        if normalized_compute and normalized_compute not in _CPU_COMPUTE_TYPES:
            raise InvalidComputeTypeError(
                f"compute_type={compute_type!r} is not valid for device=cpu "
                f"(float16/int8_float16 require a CUDA device); use one of "
                f"{sorted(_CPU_COMPUTE_TYPES)}"
            )
    # Unknown device strings (e.g. "auto") are passed through to CTranslate2,
    # which will validate them itself.


def get_whisper_model(model: str, device: str, compute_type: str) -> Any:
    """Return a cached WhisperModel for the given parameters, loading once.

    The model is loaded lazily on first request for a given
    (model, device, compute_type) key and reused thereafter. Loading happens
    inside the lock so concurrent first-time requests do not each pay the cost
    of constructing the same model.

    The device/compute_type pairing is validated first so requesting CUDA on a
    CPU-only box (or an incompatible compute_type) fails with a clear error
    instead of an opaque CTranslate2 crash. CUDA out-of-memory at load time is
    surfaced as :class:`CudaOutOfMemoryError` suggesting a smaller model.
    """
    validate_device_and_compute_type(device, compute_type)

    key = (model, device, compute_type)
    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached

    with _CACHE_LOCK:
        # Re-check inside the lock: another thread may have loaded it while we waited.
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached

        from faster_whisper import WhisperModel  # type: ignore

        try:
            # local_files_only=True is the CRITICAL second defence against silent
            # auto-download: faster-whisper / huggingface_hub must NOT reach the
            # network here. A model that has not been explicitly downloaded fails
            # locally and is mapped to a clean 409 (model_not_downloaded).
            model_instance = WhisperModel(
                model,
                device=device,
                compute_type=compute_type,
                local_files_only=True,
            )
        except Exception as exc:  # noqa: BLE001 - re-raise as typed/clear errors
            if _is_cuda_oom(exc):
                raise CudaOutOfMemoryError(
                    f"CUDA ran out of memory loading model {model!r}; try a smaller "
                    f"model (e.g. small or base) or free GPU memory"
                ) from exc
            if _is_missing_local_files(exc):
                raise ModelWeightsMissingError(model) from exc
            raise
        _MODEL_CACHE[key] = model_instance
        return model_instance


def clear_model_cache() -> None:
    """Drop all cached models. Primarily for tests."""
    with _CACHE_LOCK:
        _MODEL_CACHE.clear()
