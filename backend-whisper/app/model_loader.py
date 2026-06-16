from __future__ import annotations

import threading
from typing import Any

# Module-level cache of loaded WhisperModel instances keyed by the parameters
# that affect model identity. FastAPI runs sync handlers in a threadpool, so the
# cache must be guarded by a lock to avoid loading the same model twice (or
# corrupting the dict) under concurrent requests.
_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
_CACHE_LOCK = threading.Lock()


def get_whisper_model(model: str, device: str, compute_type: str) -> Any:
    """Return a cached WhisperModel for the given parameters, loading once.

    The model is loaded lazily on first request for a given
    (model, device, compute_type) key and reused thereafter. Loading happens
    inside the lock so concurrent first-time requests do not each pay the cost
    of constructing the same model.
    """
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

        model_instance = WhisperModel(model, device=device, compute_type=compute_type)
        _MODEL_CACHE[key] = model_instance
        return model_instance


def clear_model_cache() -> None:
    """Drop all cached models. Primarily for tests."""
    with _CACHE_LOCK:
        _MODEL_CACHE.clear()
