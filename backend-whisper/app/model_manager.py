from __future__ import annotations

import os
import queue
import shutil
import threading
from pathlib import Path
from typing import Iterator, Mapping

from .catalog import ADVERTISED_MODELS, descriptor_for
from .model_cache import (
    dir_has_weights,
    cache_dir_name_for_model,
    cache_root_from_env,
    describe_model_cache,
    repo_id_for_model,
)
from .preflight import (
    available_ram_mb,
    model_ram_requirements_mb,
    model_vram_requirements_mb,
)


class ModelNotDownloadedError(RuntimeError):
    """A model was requested for transcription but is not present in the cache.

    Mapped to HTTP 409 ``model_not_downloaded`` by the API layer so the client
    knows to call ``POST /models/download`` explicitly. Models are NEVER
    silently auto-downloaded at transcribe time.
    """

    def __init__(self, model: str) -> None:
        super().__init__(f"Model {model!r} is not downloaded; download it before transcribing")
        self.model = model


class UnknownModelError(ValueError):
    """A model id outside :data:`ADVERTISED_MODELS` was supplied."""

    def __init__(self, model: str) -> None:
        super().__init__(f"Unknown model {model!r}; expected one of {', '.join(ADVERTISED_MODELS)}")
        self.model = model


def normalize_model(model: str) -> str:
    """Normalize and validate a model id against the advertised set.

    Raises :class:`UnknownModelError` for anything outside the known set so the
    management endpoints can map it to a 400.
    """
    normalized = (model or "").strip().lower()
    if normalized not in ADVERTISED_MODELS:
        raise UnknownModelError(model)
    return normalized


def repo_id_for(model: str) -> str:
    """The Hugging Face repo id for a (validated) model id.

    Delegates to the single source of truth in model_cache so download, cache
    detection, and delete all agree (notably large-v3-turbo lives under a
    different org than the Systran default).
    """
    return repo_id_for_model(model)


def _dir_size_mb(path: Path) -> int:
    """Total size (MB) of all files under ``path``, following the real files.

    Hugging Face snapshots are symlinks into the blob store; ``stat`` follows the
    link so the reported size reflects the actual bytes on disk.
    """
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:  # pragma: no cover - race with deletion
            continue
    return int(total / 1024 / 1024)


def describe_models(env: Mapping[str, str] | None = None) -> list[dict]:
    """Describe every advertised model for ``GET /models``.

    For each model: downloaded flag + cachePath come from
    :func:`describe_model_cache`; sizeMb is the real on-disk size when
    downloaded, else the descriptor's approximate download size.
    """
    free_ram = available_ram_mb()
    models: list[dict] = []
    for model in ADVERTISED_MODELS:
        cache = describe_model_cache(model, free_ram, env=env)
        downloaded = bool(cache["cached"])
        cache_path = cache["cache_path"]
        if downloaded and cache_path:
            size_mb = _dir_size_mb(Path(cache_path))
        else:
            size_mb = descriptor_for(model).size_mb
        models.append(
            {
                "id": model,
                "downloaded": downloaded,
                "sizeMb": size_mb,
                "requiredRamMb": model_ram_requirements_mb(model)["required"],
                "requiredVramMb": model_vram_requirements_mb(model)["required"],
                "cachePath": cache_path,
            }
        )
    return models


def is_model_downloaded(model: str, env: Mapping[str, str] | None = None) -> bool:
    """True when the (validated) model is already present in the cache root."""
    normalized = normalize_model(model)
    cache = describe_model_cache(normalized, available_ram_mb(), env=env)
    return bool(cache["cached"])


def assert_model_downloaded(model: str, env: Mapping[str, str] | None = None) -> None:
    """Raise :class:`ModelNotDownloadedError` if a known model is not cached.

    Local-path model ids (absolute/relative paths) bypass this check — they are
    not part of the managed set and faster-whisper resolves them directly.
    """
    raw = (model or "").strip()
    if raw.startswith(("/", "./", "../", "~")) or "\\" in raw:
        return
    normalized = raw.lower()
    if normalized not in ADVERTISED_MODELS:
        # Not a managed model id; let the loader surface its own error.
        return
    if not is_model_downloaded(normalized, env=env):
        raise ModelNotDownloadedError(normalized)


def _download_cache_dir(env: Mapping[str, str] | None = None) -> Path:
    """The cache_dir passed to ``snapshot_download`` (the HF cache root)."""
    return cache_root_from_env(env)


# Max seconds to wait for a single download progress tick before checking whether
# the worker thread is still alive (defensive against a hung/dead worker).
_DOWNLOAD_STALL_TIMEOUT_S = 900

# One lock per model id so concurrent downloads of the same model serialize
# instead of each spawning an independent snapshot_download (wasted bandwidth).
_DOWNLOAD_LOCKS: dict[str, threading.Lock] = {}
_DOWNLOAD_LOCKS_GUARD = threading.Lock()


def _download_lock(model: str) -> threading.Lock:
    with _DOWNLOAD_LOCKS_GUARD:
        lock = _DOWNLOAD_LOCKS.get(model)
        if lock is None:
            lock = threading.Lock()
            _DOWNLOAD_LOCKS[model] = lock
        return lock


def _snapshot_has_weights(snapshot_dir: str | None) -> bool:
    """Guard against a partial download leaving the dir present but weightless
    (which would otherwise read as "downloaded" and then fail every transcription)."""
    return bool(snapshot_dir) and dir_has_weights(Path(snapshot_dir))


def _download_scope(model: str) -> dict:
    """``snapshot_download`` kwargs limiting a single-file model to that file."""
    weights_file = descriptor_for(model).weights_file
    return {"allow_patterns": [weights_file]} if weights_file else {}


def _make_progress_tqdm(progress_queue: "queue.Queue[dict]"):
    """Build a tqdm subclass that pushes download progress into ``progress_queue``.

    huggingface_hub drives downloads through tqdm; passing ``tqdm_class`` lets us
    intercept every update. Each bar reports bytes (``n`` / ``total``); we
    aggregate across concurrently-updating bars by summing their latest values so
    the emitted percentage reflects the whole snapshot, not a single file.
    """
    from tqdm.auto import tqdm as _base_tqdm  # type: ignore

    # Shared aggregate state across all bar instances for this download.
    state = {"bars": {}, "lock": threading.Lock()}

    class _QueueTqdm(_base_tqdm):  # type: ignore[misc]
        def update(self, n=1):
            result = super().update(n)
            self._publish()
            return result

        def close(self):
            # Drop this bar so its total isn't double-counted in the aggregate
            # after it finishes (multi-file downloads create many bars).
            with state["lock"]:
                state["bars"].pop(id(self), None)
            return super().close()

        def _publish(self) -> None:
            with state["lock"]:
                state["bars"][id(self)] = (
                    float(getattr(self, "n", 0) or 0),
                    float(getattr(self, "total", 0) or 0),
                )
                downloaded = sum(n for n, _ in state["bars"].values())
                total = sum(t for _, t in state["bars"].values())
            downloaded_mb = downloaded / 1024 / 1024
            total_mb = total / 1024 / 1024
            pct = (downloaded / total * 100.0) if total > 0 else 0.0
            progress_queue.put(
                {
                    "type": "progress",
                    "pct": round(max(0.0, min(100.0, pct)), 2),
                    "downloadedMb": round(downloaded_mb, 2),
                    "totalMb": round(total_mb, 2),
                }
            )

    return _QueueTqdm


def download_model_events(
    model: str,
    env: Mapping[str, str] | None = None,
) -> Iterator[dict]:
    """Yield NDJSON-shaped dicts while downloading a model snapshot.

    Emits ``{"type":"progress", ...}`` lines during the download and a terminal
    ``{"type":"result", ...}`` (or ``{"type":"error", ...}``) line. Already
    downloaded → emits a single idempotent ``result`` immediately. The blocking
    ``snapshot_download`` runs on a worker thread; progress flows back through a
    queue this generator drains, mirroring the executor+queue pattern used by
    ``/transcribe/stream`` so the event loop is never blocked.

    Validation (unknown model id) is the caller's responsibility — it must call
    :func:`normalize_model` first so a 400 is raised before the stream opens.
    """
    normalized = normalize_model(model)

    if is_model_downloaded(normalized, env=env):
        cache = describe_model_cache(normalized, available_ram_mb(), env=env)
        yield {
            "type": "result",
            "ok": True,
            "model": normalized,
            "cachePath": cache["cache_path"],
            "alreadyPresent": True,
        }
        return

    # Serialize concurrent downloads of the SAME model: a second request blocks
    # here, then re-checks is_model_downloaded below and returns the idempotent
    # "already present" result instead of running a second snapshot_download.
    with _download_lock(normalized):
        if is_model_downloaded(normalized, env=env):
            cache = describe_model_cache(normalized, available_ram_mb(), env=env)
            yield {
                "type": "result",
                "ok": True,
                "model": normalized,
                "cachePath": cache["cache_path"],
                "alreadyPresent": True,
            }
            return

        progress_queue: "queue.Queue[dict]" = queue.Queue()
        sentinel = object()
        result_holder: dict = {}

        def worker() -> None:
            try:
                from huggingface_hub import snapshot_download  # type: ignore

                tqdm_class = _make_progress_tqdm(progress_queue)
                path = snapshot_download(
                    repo_id=repo_id_for(normalized),
                    cache_dir=str(_download_cache_dir(env)),
                    tqdm_class=tqdm_class,
                    **_download_scope(normalized),
                )
                result_holder["path"] = path
            except Exception as exc:  # noqa: BLE001 - surface as a terminal error line
                result_holder["error"] = str(exc)
            finally:
                progress_queue.put(sentinel)  # type: ignore[arg-type]

        thread = threading.Thread(target=worker, name=f"hf-download-{normalized}", daemon=True)
        thread.start()

        # Bounded get so a worker that dies WITHOUT posting the sentinel (a future
        # exception-path bug) can never hang the stream forever — fall through when
        # the thread is no longer alive.
        while True:
            try:
                item = progress_queue.get(timeout=_DOWNLOAD_STALL_TIMEOUT_S)
            except queue.Empty:
                if not thread.is_alive():
                    break
                continue
            if item is sentinel:
                break
            yield item

        thread.join(timeout=_DOWNLOAD_STALL_TIMEOUT_S)

        if "error" in result_holder:
            yield {"type": "error", "error": result_holder["error"], "model": normalized}
            return

        # Re-describe so cachePath reflects the freshly-written snapshot.
        cache = describe_model_cache(normalized, available_ram_mb(), env=env)
        cache_path = cache["cache_path"] or result_holder.get("path")
        # Integrity gate: a partial/interrupted download can leave a snapshot dir
        # without the CTranslate2 weights. Reporting success here would make the
        # model show as "downloaded" yet fail every transcription, so verify the
        # weight file is actually present before declaring success.
        if not _snapshot_has_weights(cache_path):
            yield {
                "type": "error",
                "error": (
                    "Download finished but the model weights (model.bin or .gguf) are "
                    "missing; the snapshot is incomplete — delete it and download again"
                ),
                "model": normalized,
            }
            return
        yield {
            "type": "result",
            "ok": True,
            "model": normalized,
            "cachePath": cache_path,
        }


def delete_model(model: str, env: Mapping[str, str] | None = None) -> dict:
    """Delete the cached snapshot for a model, returning freed size.

    Removes the whole ``models--Systran--faster-whisper-<model>`` cache entry
    (snapshots + blobs + refs) so the space is actually reclaimed, not just the
    snapshot symlink dir. Raises :class:`UnknownModelError` for a bad id and
    :class:`ModelNotDownloadedError` (→ 404) when nothing is cached.
    """
    normalized = normalize_model(model)
    if not is_model_downloaded(normalized, env=env):
        raise ModelNotDownloadedError(normalized)

    cache_root = cache_root_from_env(env)
    repo_dir_name = cache_dir_name_for_model(normalized)
    candidates = [
        cache_root / "hub" / repo_dir_name,
        cache_root / repo_dir_name,
        cache_root / f"faster-whisper-{normalized}",
        cache_root / normalized,
    ]

    def _try_remove(target: Path) -> int:
        """Remove a cache dir, returning freed MB. Raise on a real failure so the
        API surfaces it instead of reporting a phantom success (e.g. a Windows
        file lock from a still-loaded model)."""
        size = _dir_size_mb(target)
        try:
            shutil.rmtree(target)
        except OSError as exc:
            raise OSError(
                f"Failed to delete cached model {normalized!r} at {target}: {exc}. "
                f"It may be in use — stop any running transcription and retry."
            ) from exc
        return size

    freed_mb = 0
    removed_any = False
    for candidate in candidates:
        if candidate.is_dir():
            freed_mb += _try_remove(candidate)
            removed_any = True

    if not removed_any:
        # describe_model_cache saw a cached path but our candidate roots did not
        # match it — fall back to removing exactly what was reported.
        cache = describe_model_cache(normalized, available_ram_mb(), env=env)
        cache_path = cache["cache_path"]
        if cache_path and Path(cache_path).exists():
            freed_mb += _try_remove(Path(cache_path))
            removed_any = True

    if not removed_any:  # pragma: no cover - defensive; cached implied existence
        raise ModelNotDownloadedError(normalized)

    return {"ok": True, "freedMb": freed_mb}
