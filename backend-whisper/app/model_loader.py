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
            model_instance = WhisperModel(model, device=device, compute_type=compute_type)
        except Exception as exc:  # noqa: BLE001 - re-raise as typed/clear errors
            if _is_cuda_oom(exc):
                raise CudaOutOfMemoryError(
                    f"CUDA ran out of memory loading model {model!r}; try a smaller "
                    f"model (e.g. small or base) or free GPU memory"
                ) from exc
            raise
        _MODEL_CACHE[key] = model_instance
        return model_instance


def clear_model_cache() -> None:
    """Drop all cached models. Primarily for tests."""
    with _CACHE_LOCK:
        _MODEL_CACHE.clear()
