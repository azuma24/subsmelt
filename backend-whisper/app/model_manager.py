from __future__ import annotations

import getpass
import io
import multiprocessing
import os
import shutil
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator, Mapping
from multiprocessing.connection import Connection
from pathlib import Path
from uuid import uuid4

from . import nemotron_runtime, whispercpp_runtime
from .catalog import ADVERTISED_MODELS, MODELS, ModelDescriptor, descriptor_for, to_wire
from .engine import EngineUnavailableError
from .model_cache import (
    cache_dir_name_for_model,
    cache_root_from_env,
    describe_model_cache,
    is_model_cache_ready,
    repo_id_for_model,
)
from .model_loader import is_model_leased
from .preflight import available_ram_mb

# Whether each engine can run on this host, probed at request time so a binary
# installed after startup is picked up.
ENGINE_AVAILABILITY: dict[str, Callable[[], tuple[bool, str | None]]] = {
    "whisper": lambda: (True, None),
    "whispercpp": whispercpp_runtime.availability,
    "nemotron": nemotron_runtime.availability,
}


def _wire(descriptor: ModelDescriptor) -> dict:
    available, reason = ENGINE_AVAILABILITY[descriptor.engine]()
    return to_wire(descriptor, available, reason)


def describe_model_info() -> list[dict]:
    """``capabilities.modelInfo``: every descriptor with its availability."""
    return [_wire(descriptor) for descriptor in MODELS]


def assert_engine_available(model: str) -> None:
    descriptor = descriptor_for(model)
    if descriptor is None:
        return
    available, reason = ENGINE_AVAILABILITY[descriptor.engine]()
    if not available:
        raise EngineUnavailableError(model, reason or f"{descriptor.engine} engine is not available")


class ModelNotDownloadedError(RuntimeError):
    """A model was requested for transcription but is not present in the cache.

    Mapped to HTTP 409 ``model_not_downloaded`` by the API layer so the client
    knows to call ``POST /models/download`` explicitly. Models are NEVER
    silently auto-downloaded at transcribe time.
    """

    def __init__(self, model: str) -> None:
        super().__init__(f"Model {model!r} is not downloaded; download it before transcribing")
        self.model = model


class ModelInUseError(RuntimeError):
    """A model was asked to be deleted while a transcription holds a lease on it.

    Mapped to HTTP 409 by the API layer; the files stay until the lease ends.
    """

    def __init__(self, model: str) -> None:
        super().__init__(f"Model {model!r} is in use by a running transcription; retry when it finishes")
        self.model = model


class ModelDownloadInProgressError(RuntimeError):
    """The download owns the cache entry until its worker has exited."""

    def __init__(self, model: str) -> None:
        super().__init__(f"Model {model!r} is being downloaded; cancel the download or wait for it to finish")
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
    """Total size (MB) of the files under ``path``, each counted once.

    Hugging Face snapshots are symlinks into the blob store, so a repo dir names
    every weight twice; deduping on inode counts the bytes once whether ``path``
    is the repo dir or the snapshot inside it.
    """
    seen: set[tuple[int, int]] = set()
    total = 0
    for child in path.rglob("*"):
        try:
            if not child.is_file():
                continue
            stat = child.stat()
        except OSError:  # pragma: no cover - race with deletion
            continue
        if (stat.st_dev, stat.st_ino) in seen:
            continue
        seen.add((stat.st_dev, stat.st_ino))
        total += stat.st_size
    return int(total / 1024 / 1024)


def describe_models(env: Mapping[str, str] | None = None) -> list[dict]:
    """Describe every advertised model for ``GET /models``.

    For each model: downloaded flag + cachePath come from
    :func:`describe_model_cache`; sizeMb is the real on-disk size when
    downloaded, else the descriptor's approximate download size.
    """
    free_ram = available_ram_mb()
    downloads = _download_statuses(cache_root_from_env(env).resolve())
    models: list[dict] = []
    for descriptor in MODELS:
        cache = describe_model_cache(descriptor.id, free_ram, env=env)
        download = downloads.get(descriptor.id)
        downloaded = bool(cache["cached"]) and (not download or download["status"] not in _ACTIVE_DOWNLOAD_STATES)
        cache_path = cache["cache_path"] if downloaded else None
        entry = _wire(descriptor)
        if downloaded and cache_path:
            entry["sizeMb"] = _dir_size_mb(Path(cache_path))
        if download is not None:
            entry["download"] = download
        models.append({**entry, "downloaded": downloaded, "cachePath": cache_path})
    return models


def is_model_downloaded(model: str, env: Mapping[str, str] | None = None) -> bool:
    """True when the (validated) model is already present in the cache root."""
    normalized = normalize_model(model)
    with _DOWNLOAD_CHANGED:
        if (cache_root_from_env(env).resolve(), normalized) in _ACTIVE_DOWNLOADS:
            return False
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


def _permission_message(error: PermissionError, cache_dir: Path) -> str:
    """Why a download could not write: the account, the folder and the way out.

    The Windows installer lets only SYSTEM and Administrators write the models
    folder. The installed service runs as SYSTEM; a copy of the backend started
    under a user account (from a command line, or an older control window) can
    read the models but not download new ones.
    """
    try:
        account = getpass.getuser()
    except Exception:  # pragma: no cover - no user name in this environment
        account = "an account"
    return (
        f"{error}. This backend runs as {account}, which cannot write to {cache_dir}. "
        "On Windows, download through the installed SubSmeltWhisper service: stop this "
        "copy of the backend and start the service."
    )


_DOWNLOAD_STALL_TIMEOUT_S = 120
_DOWNLOAD_RETRY_DELAYS_S = (1, 3)
_DOWNLOAD_POLL_S = 0.25
_DOWNLOAD_CONTEXT = multiprocessing.get_context("spawn")
_DOWNLOAD_CHANGED = threading.Condition()
_ACTIVE_DOWNLOAD_STATES = ("running", "cancelling")
_ACTIVE_DOWNLOADS: dict[tuple[Path, str], ModelDownload] = {}
_DOWNLOADS: dict[str, ModelDownload] = {}
_MAX_FINISHED_DOWNLOADS = 64


def _download_scope(model: str) -> dict:
    """``snapshot_download`` kwargs limiting a single-file model to that file."""
    weights_file = descriptor_for(model).weights_file
    return {"allow_patterns": [weights_file]} if weights_file else {}


def _make_progress_tqdm(emit: Callable[[dict], None], expected_bytes: float = 0.0):
    """Build a tqdm subclass that publishes download progress.

    huggingface_hub 1.x builds three bars from ``tqdm_class`` per snapshot: bytes
    received ("Downloading bytes", updated often but against an inflated total
    estimate), bytes written to disk ("Reconstructing ...", whose total is the
    true size but which updates rarely and late), and a file counter. Summing
    them double-counted every byte; following the written bar alone left the
    stream silent for most of a download. So progress is the furthest either
    byte bar has got, and it never goes backwards. Totals grow as each file
    starts, so the catalog size of the model (``expected_bytes``) is the
    denominator until a bar knows better; otherwise the small config files
    would read as 100% before the weights begin. ``finish()``, called once the
    download returns, reports one last event against the true size.
    """
    from tqdm.auto import tqdm as _base_tqdm  # type: ignore

    state = {
        "transfer": None,
        "written": None,
        "pct": 0.0,
        "last": None,
        "last_activity": 0.0,
        "lock": threading.Lock(),
    }

    class _QueueTqdm(_base_tqdm):  # type: ignore[misc]
        def __init__(self, *args, **kwargs):
            # The bar is read through the queue, never printed. Its default
            # output, sys.stderr, is None in the Windows service.
            kwargs.setdefault("file", io.StringIO())
            super().__init__(*args, **kwargs)
            if kwargs.get("unit") != "B":
                return
            role = "written" if str(kwargs.get("desc") or "").startswith("Reconstruct") else "transfer"
            with state["lock"]:
                if state[role] is None:
                    state[role] = self

        def update(self, n=1):
            result = super().update(n)
            tracked = self is state["transfer"] or self is state["written"]
            with state["lock"]:
                if tracked and self._publish():
                    state["last_activity"] = time.monotonic()
                elif n > 0 and time.monotonic() - state["last_activity"] >= 1:
                    state["last_activity"] = time.monotonic()
                    emit({"type": "activity"})
            return result

        def _publish(self, final: bool = False) -> bool:
            bars = [bar for bar in (state["transfer"], state["written"]) if bar is not None]
            written = state["written"]
            total = float(written.total or 0) if written is not None else 0.0
            if total <= 0:
                total = max(float(bar.total or 0) for bar in bars)
            if not final:
                total = max(total, expected_bytes)
            if total <= 0:
                return False
            downloaded = min(total, max(float(bar.n or 0) for bar in bars))
            state["pct"] = max(state["pct"], min(100.0, downloaded / total * 100.0))
            event = {
                "type": "progress",
                "pct": round(state["pct"], 2),
                "downloadedMb": round(downloaded / 1024 / 1024, 2),
                "totalMb": round(total / 1024 / 1024, 2),
            }
            if event == state["last"]:
                return False
            state["last"] = event
            emit(event)
            return True

        @classmethod
        def finish(cls) -> None:
            with state["lock"]:
                bar = state["written"] if state["written"] is not None else state["transfer"]
                if bar is not None:
                    bar._publish(final=True)

    return _QueueTqdm


class ModelDownload:
    def __init__(self, model: str, cache_root: Path) -> None:
        self.id = uuid4().hex
        self.model = model
        self.cache_root = cache_root
        self.key = (cache_root.resolve(), model)
        self.status = "running"
        self.cancelled = threading.Event()
        self.progress: dict | None = None
        self.terminal: dict | None = None
        self._events: deque[tuple[int, dict]] = deque(maxlen=32)
        self._sequence = 0

    def snapshot(self) -> dict:
        with _DOWNLOAD_CHANGED:
            return {
                "id": self.id,
                "model": self.model,
                "status": self.status,
                **({"progress": self.progress} if self.progress is not None else {}),
                **({"error": self.terminal["error"]} if self.terminal and self.status == "failed" else {}),
                **({"cachePath": self.terminal["cachePath"]} if self.terminal and self.status == "succeeded" else {}),
            }

    def events_after(self, sequence: int) -> tuple[int, list[dict], bool]:
        with _DOWNLOAD_CHANGED:
            return (
                self._sequence,
                [event for index, event in self._events if index > sequence],
                self.terminal is not None,
            )

    def _publish(self, event: dict) -> None:
        self._sequence += 1
        self._events.append((self._sequence, event))
        _DOWNLOAD_CHANGED.notify_all()

    def _progress(self, event: dict) -> None:
        with _DOWNLOAD_CHANGED:
            if self.progress is not None and event["pct"] < self.progress["pct"]:
                # A new attempt can reconstruct cached bytes from zero. Keep
                # showing the last known high-water mark until it catches up.
                return
            self.progress = {key: value for key, value in event.items() if key != "type"}
            self._publish(event)

    def _finish(self, event: dict) -> None:
        with _DOWNLOAD_CHANGED:
            if self.cancelled.is_set():
                self.status = "cancelled"
                event = {
                    "type": "error",
                    "error": "Model download cancelled",
                    "code": "model_download_cancelled",
                    "model": self.model,
                }
            else:
                self.status = "succeeded" if event["type"] == "result" else "failed"
            self.terminal = event
            _ACTIVE_DOWNLOADS.pop(self.key, None)
            _DOWNLOADS.pop(self.id)
            _DOWNLOADS[self.id] = self
            self._publish(event)
            finished = [operation_id for operation_id, op in _DOWNLOADS.items() if op.terminal is not None]
            for operation_id in finished[:-_MAX_FINISHED_DOWNLOADS]:
                del _DOWNLOADS[operation_id]


def _download_statuses(cache_root: Path) -> dict[str, dict]:
    with _DOWNLOAD_CHANGED:
        return {op.model: op.snapshot() for op in _DOWNLOADS.values() if op.key[0] == cache_root}


def find_model_download(operation_id: str) -> dict | None:
    with _DOWNLOAD_CHANGED:
        operation = _DOWNLOADS.get(operation_id)
        return operation.snapshot() if operation is not None else None


def cancel_model_download(operation_id: str) -> dict | None:
    with _DOWNLOAD_CHANGED:
        operation = _DOWNLOADS.get(operation_id)
        if operation is None:
            return None
        if operation.status == "running":
            operation.status = "cancelling"
            operation.cancelled.set()
        return operation.snapshot()


def shutdown_model_downloads() -> None:
    with _DOWNLOAD_CHANGED:
        for operation in _ACTIVE_DOWNLOADS.values():
            cancel_model_download(operation.id)
        _DOWNLOAD_CHANGED.wait_for(lambda: not _ACTIVE_DOWNLOADS)


def start_model_download(model: str, env: Mapping[str, str] | None = None) -> ModelDownload:
    normalized = normalize_model(model)
    cache_root = cache_root_from_env(env)
    key = (cache_root.resolve(), normalized)
    with _DOWNLOAD_CHANGED:
        active = _ACTIVE_DOWNLOADS.get(key)
        if active is not None:
            return active
        cache = describe_model_cache(normalized, available_ram_mb(), env=env)
        operation = ModelDownload(normalized, cache_root)
        _DOWNLOADS[operation.id] = operation
        if cache["cached"]:
            operation._finish(_download_result(normalized, cache["cache_path"], alreadyPresent=True))
        else:
            _ACTIVE_DOWNLOADS[key] = operation
            try:
                threading.Thread(
                    target=_supervise_download, args=(operation,), name=f"download-{normalized}", daemon=True
                ).start()
            except Exception as exc:
                operation._finish(_download_error(normalized, str(exc)))
        return operation


def download_model_events(model: str, env: Mapping[str, str] | None = None) -> Iterator[dict]:
    """Stream the events of the existing download or start a new one."""
    operation = start_model_download(model, env)
    sequence = 0
    while True:
        with _DOWNLOAD_CHANGED:
            _DOWNLOAD_CHANGED.wait_for(lambda current=sequence: operation._sequence > current)
            sequence, events, finished = operation.events_after(sequence)
        yield from events
        if finished:
            return


def _is_transient_download_error(error: Exception) -> bool:
    from httpx import TransportError

    cause: BaseException | None = error
    while cause is not None:
        if isinstance(cause, (TimeoutError, ConnectionError, TransportError)):
            return True
        status = getattr(getattr(cause, "response", None), "status_code", None)
        if status is not None:
            return status in (408, 429) or 500 <= status <= 599
        if (
            isinstance(cause, RuntimeError)
            and "CAS service error" in str(cause)
            and any(term in str(cause).lower() for term in ("timed out", "connection reset", "503 service unavailable"))
        ):
            return True
        cause = cause.__cause__
    return False


def _download_in_process(model: str, cache_root: Path, emit: Callable[[dict], None]) -> None:
    try:
        from huggingface_hub import snapshot_download  # type: ignore

        tqdm_class = _make_progress_tqdm(emit, descriptor_for(model).size_mb * 1024 * 1024)
        path = snapshot_download(
            repo_id=repo_id_for(model),
            cache_dir=str(cache_root),
            tqdm_class=tqdm_class,
            **_download_scope(model),
        )
        tqdm_class.finish()
        emit({"type": "complete", "path": path})
    except PermissionError as exc:
        emit({"type": "failed", "error": _permission_message(exc, cache_root)})
    except Exception as exc:
        emit(
            {
                "type": "failed",
                "error": str(exc)[:1200] or type(exc).__name__,
                "retry": _is_transient_download_error(exc),
            }
        )


def _download_worker(model: str, cache_root: Path, sender: Connection) -> None:
    parent = multiprocessing.parent_process()
    if parent is not None:
        # A forcibly stopped backend cannot terminate the child itself.
        def exit_with_parent() -> None:
            parent.join()
            os._exit(1)

        threading.Thread(target=exit_with_parent, daemon=True).start()
    with sender:
        _download_in_process(model, cache_root, sender.send)


def _run_download_attempt(operation: ModelDownload) -> dict:
    reader, writer = _DOWNLOAD_CONTEXT.Pipe(duplex=False)
    process = _DOWNLOAD_CONTEXT.Process(
        target=_download_worker, args=(operation.model, operation.cache_root, writer), daemon=True
    )
    with reader, writer:
        process.start()
        writer.close()
        try:
            deadline = time.monotonic() + _DOWNLOAD_STALL_TIMEOUT_S
            while not operation.cancelled.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return {"error": f"Model download stalled for {_DOWNLOAD_STALL_TIMEOUT_S:g} seconds", "retry": True}
                if not reader.poll(min(remaining, _DOWNLOAD_POLL_S)):
                    continue
                try:
                    event = reader.recv()
                except EOFError:
                    return {"error": "Model download worker stopped unexpectedly"}
                if event["type"] in ("complete", "failed"):
                    # Keep ownership until the process exits, even if it has
                    # already reported a result or entered finalization.
                    deadline = time.monotonic() + _DOWNLOAD_STALL_TIMEOUT_S
                    while process.is_alive() and not operation.cancelled.is_set():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            return {"error": "Model download worker stalled while exiting", "retry": True}
                        process.join(min(remaining, _DOWNLOAD_POLL_S))
                    if process.exitcode not in (0, None):
                        return {"error": f"Model download worker exited with code {process.exitcode}"}
                    return event
                deadline = time.monotonic() + _DOWNLOAD_STALL_TIMEOUT_S
                if event["type"] == "progress":
                    operation._progress(event)
            return {"error": "Model download cancelled"}
        finally:
            if process.is_alive():
                process.terminate()
                process.join(1)
                if process.is_alive():
                    process.kill()
            process.join()
            process.close()


def _download_error(model: str, message: str) -> dict:
    return {"type": "error", "error": message, "model": model}


def _download_result(model: str, path: str, **extra: bool) -> dict:
    return {"type": "result", "ok": True, "model": model, "cachePath": path, **extra}


def _supervise_download(operation: ModelDownload) -> None:
    model = operation.model
    result = _download_error(model, "Model download cancelled")
    try:
        delays = iter(_DOWNLOAD_RETRY_DELAYS_S)
        while not operation.cancelled.is_set():
            attempt = _run_download_attempt(operation)
            if attempt.get("type") == "complete":
                path = attempt["path"]
                cache = describe_model_cache(model, available_ram_mb(), env={"HF_HOME": str(operation.cache_root)})
                if path and is_model_cache_ready(model, Path(path)) and cache["cached"]:
                    result = _download_result(model, cache["cache_path"])
                else:
                    result = _download_error(
                        model,
                        "Download finished with an incomplete snapshot (missing model.bin, model metadata, or weights)",
                    )
                break
            result = _download_error(model, attempt["error"])
            delay = next(delays, None)
            if not attempt.get("retry") or delay is None or operation.cancelled.wait(delay):
                break
    except Exception as exc:
        result = _download_error(model, str(exc) or type(exc).__name__)
    finally:
        operation._finish(result)


def delete_model(model: str, env: Mapping[str, str] | None = None) -> dict:
    """Delete the cached snapshot for a model, returning freed size.

    Removes the whole ``models--Systran--faster-whisper-<model>`` cache entry
    (snapshots + blobs + refs) so the space is actually reclaimed, not just the
    snapshot symlink dir. The bare-name layouts (``<root>/<id>``,
    ``<root>/faster-whisper-<id>``) go only when they hold weights, since a
    directory merely named like a model may be anything. Raises
    :class:`UnknownModelError` for a bad id, :class:`ModelNotDownloadedError`
    (→ 404) when nothing is cached and :class:`ModelInUseError` (→ 409) while a
    transcription leases the model.
    """
    normalized = normalize_model(model)
    with _DOWNLOAD_CHANGED:
        if (cache_root_from_env(env).resolve(), normalized) in _ACTIVE_DOWNLOADS:
            raise ModelDownloadInProgressError(normalized)
        return _delete_cached_model(normalized, env)


def _delete_cached_model(normalized: str, env: Mapping[str, str] | None) -> dict:
    if not is_model_downloaded(normalized, env=env):
        raise ModelNotDownloadedError(normalized)
    if is_model_leased(normalized):
        raise ModelInUseError(normalized)

    cache_root = cache_root_from_env(env)
    repo_dir_name = cache_dir_name_for_model(normalized)
    repo_dirs = {cache_root / "hub" / repo_dir_name, cache_root / repo_dir_name}
    candidates = [
        *repo_dirs,
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
        if candidate.is_dir() and (candidate in repo_dirs or is_model_cache_ready(normalized, candidate)):
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
