from __future__ import annotations

import gc
import sys
import threading
from contextlib import contextmanager
from typing import Any, Iterator

from .gpu import cuda_device_count
from .model_cache import cache_root_from_env, describe_model_cache
from .preflight import available_ram_mb

# Module-level cache of loaded WhisperModel instances keyed by the parameters
# that affect model identity. FastAPI runs sync handlers in a threadpool, so the
# cache must be guarded by a lock to avoid loading the same model twice (or
# corrupting the dict) under concurrent requests.
#
# At most ONE model is resident: loading a different key evicts the current one
# so its VRAM comes back instead of every variant pinning GPU memory forever.
# A transcription holds a ``lease`` while it runs; an evicted model that is
# still leased is parked in _RETIRED and released when the last lease ends.
_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
_LEASES: dict[tuple[str, str, str], int] = {}
_RETIRED: dict[tuple[str, str, str], Any] = {}
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
    return (
        "out of memory" in text
        or "cuda_error_out_of_memory" in text
        or ("cublas" in text and "alloc" in text)
    )


def _resolve_model_source(model: str) -> str:
    """Resolve a model id to the exact on-disk snapshot dir, if present.

    Loading from the path the cache detector found makes load == detection: the
    same describe_model_cache that powers /models, /health and
    assert_model_downloaded picks the directory, so a model can never be
    reported "downloaded" yet fail to load because faster-whisper looked in a
    different HF cache layout (``<root>`` vs ``<root>/hub``). Falls back to the
    raw id (local-path ids, or genuinely-uncached models) when no snapshot is
    found — those resolve through faster-whisper with local_files_only=True.
    """
    try:
        info = describe_model_cache(model, available_ram_mb())
    except Exception:  # noqa: BLE001 - never let detection break loading
        return model
    path = info.get("cache_path")
    if info.get("cached") and path:
        return path
    return model


def _cache_key(model: str, device: str, compute_type: str) -> tuple[str, str, str]:
    """Cache key with managed model ids normalized so ``Small`` and ``small``
    do not load (and pin VRAM for) two separate WhisperModel instances. Local
    path ids keep their original case."""
    key_model = model.strip()
    if not (key_model.startswith(("/", "./", "../", "~")) or "/" in key_model or "\\" in key_model):
        key_model = key_model.lower()
    return (key_model, device, compute_type)


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
    """Return the resident WhisperModel for the given parameters, loading it once.

    Lookup and load both happen under ``_CACHE_LOCK`` so concurrent first-time
    requests do not each construct the model, and so a ``lease`` can never be
    handed an instance that a competing load evicted in between.

    The device/compute_type pairing is validated first so requesting CUDA on a
    CPU-only box (or an incompatible compute_type) fails with a clear error
    instead of an opaque CTranslate2 crash. CUDA out-of-memory at load time is
    surfaced as :class:`CudaOutOfMemoryError` suggesting a smaller model.
    """
    validate_device_and_compute_type(device, compute_type)
    with _CACHE_LOCK:
        return _resident_locked(model, device, compute_type)


def _resident_locked(model: str, device: str, compute_type: str) -> Any:
    """The cached instance for the key, loading (and evicting the previous
    resident) when absent. Caller holds ``_CACHE_LOCK``."""
    key = _cache_key(model, device, compute_type)
    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached

    # Evicted while another transcription still leases it: reinstate that
    # instance instead of loading a second copy of the same weights.
    retired = _RETIRED.pop(key, None)
    if retired is not None:
        _evict_locked(lambda other: other != key)
        _MODEL_CACHE[key] = retired
        return retired

    from faster_whisper import WhisperModel  # type: ignore

    # Free the resident model before loading so the new one has its VRAM.
    _evict_locked(lambda other: True)

    # Load from the exact snapshot dir the cache detector resolved, so the
    # loader can never disagree with /models, /health and
    # assert_model_downloaded about whether a model is present — regardless
    # of HF cache layout (``<root>`` vs ``<root>/hub``) or where it was
    # downloaded from.
    source = _resolve_model_source(model)

    try:
        # local_files_only=True is the CRITICAL second defence against silent
        # auto-download: faster-whisper / huggingface_hub must NOT reach the
        # network here. A model that has not been explicitly downloaded fails
        # locally and is mapped to a clean 409 (model_not_downloaded).
        # download_root still points at the managed cache root so the fallback
        # (raw id, no resolved snapshot) looks where the downloader wrote.
        model_instance = WhisperModel(
            source,
            device=device,
            compute_type=compute_type,
            download_root=str(cache_root_from_env()),
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
    _align_feature_extractor(model_instance)
    _MODEL_CACHE[key] = model_instance
    return model_instance


def _align_feature_extractor(whisper_model: Any) -> None:
    """Force FeatureExtractor n_mels to match the CTranslate2 encoder.

    large-v3 / large-v3-turbo expect 128 mel bins. faster-whisper defaults to 80
    when preprocessor_config.json is missing from the snapshot (common with a
    weights-only HF cache). That mismatch surfaces as:
    ``Invalid input features shape: expected (1, 128, 3000), got (1, 80, 3000)``.
    """
    n_mels = getattr(getattr(whisper_model, "model", None), "n_mels", None)
    fe = getattr(whisper_model, "feature_extractor", None)
    if not n_mels or fe is None:
        return
    filters = getattr(fe, "mel_filters", None)
    current = int(filters.shape[0]) if filters is not None else 0
    if current == int(n_mels):
        return
    from faster_whisper.feature_extractor import FeatureExtractor  # type: ignore

    whisper_model.feature_extractor = FeatureExtractor(
        feature_size=int(n_mels),
        sampling_rate=getattr(fe, "sampling_rate", 16000),
        hop_length=getattr(fe, "hop_length", 160),
        chunk_length=getattr(fe, "chunk_length", 30),
        n_fft=getattr(fe, "n_fft", 400),
    )


@contextmanager
def lease(model: str, device: str, compute_type: str) -> Iterator[Any]:
    """Hold the model for the duration of a transcription.

    Eviction (a different model loading, or DELETE /models/{id}) never unloads
    a leased instance under a running decode; it is released when the last
    lease ends.
    """
    validate_device_and_compute_type(device, compute_type)
    key = _cache_key(model, device, compute_type)
    with _CACHE_LOCK:
        instance = _resident_locked(model, device, compute_type)
        _LEASES[key] = _LEASES.get(key, 0) + 1
    try:
        yield instance
    finally:
        with _CACHE_LOCK:
            _LEASES[key] -= 1
            retired = _RETIRED.pop(key, None) if _LEASES[key] == 0 else None
        if retired is not None:
            release_device_memory(retired)


def unload_model(model: str) -> bool:
    """Evict every resident variant of ``model`` (any device/compute type).

    Returns True when something was evicted. Used by DELETE /models/{id} so the
    weights are unloaded (and, on Windows, unlocked) before the cache dir goes.
    """
    wanted = _cache_key(model, "", "")[0]
    with _CACHE_LOCK:
        return _evict_locked(lambda key: key[0] == wanted) > 0


def _evict_locked(matches: Any) -> int:
    """Drop cached entries whose key satisfies ``matches``; caller holds the lock."""
    evicted = [key for key in _MODEL_CACHE if matches(key)]
    for key in evicted:
        instance = _MODEL_CACHE.pop(key)
        if _LEASES.get(key):
            _RETIRED[key] = instance
        else:
            release_device_memory(instance)
    return len(evicted)


def release_device_memory(instance: Any) -> None:
    """Return a CTranslate2 model's device memory now rather than whenever the
    GC runs. Models without ``unload_model`` are just dropped."""
    unload = getattr(getattr(instance, "model", None), "unload_model", None)
    if callable(unload):
        unload()
    del instance
    free_device_cache()


def free_device_cache() -> None:
    """Collect garbage and hand cached CUDA blocks back to the driver.

    ``torch.cuda.empty_cache`` is called only when torch is already imported
    (pyannote), never imported just for this. Call it after the last reference
    to the freed object is gone, or the blocks are still in use.
    """
    gc.collect()
    torch = sys.modules.get("torch")
    cuda = getattr(torch, "cuda", None)
    if cuda is not None and cuda.is_available():
        cuda.empty_cache()


def clear_model_cache() -> None:
    """Drop all cached models. Primarily for tests."""
    with _CACHE_LOCK:
        _MODEL_CACHE.clear()
        _LEASES.clear()
        _RETIRED.clear()
