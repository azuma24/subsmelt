"""Process-wide transcription slots, held until request and worker cleanup finish."""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import Callable
from contextvars import ContextVar
from typing import TypeVar

import anyio
from starlette.concurrency import run_in_threadpool

T = TypeVar("T")


def positive_env(name: str, default: int) -> int:
    raw = os.environ.get(name) or str(default)
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be a positive integer; got {raw!r}") from None
    if value < 1:
        raise ValueError(f"{name} must be a positive integer; got {raw!r}")
    return value


class Admission:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active = 0

    def acquire(self, limit: int) -> Reservation | None:
        with self._lock:
            if self._active >= limit:
                return None
            self._active += 1
        return Reservation(self)

    def _release(self) -> None:
        with self._lock:
            self._active -= 1


class Reservation:
    def __init__(self, admission: Admission) -> None:
        self._admission = admission
        self._lock = threading.Lock()
        self._owners = 1

    def retain(self) -> None:
        with self._lock:
            self._owners += 1

    def release(self) -> None:
        with self._lock:
            self._owners -= 1
            if self._owners == 0:
                self._admission._release()


admission = Admission()
current_reservation: ContextVar[Reservation | None] = ContextVar("transcription_reservation", default=None)


async def run_blocking(func: Callable[..., T], *args, **kwargs) -> T:
    return await wait_for_cleanup(asyncio.create_task(run_in_threadpool(func, *args, **kwargs)))


async def wait_for_cleanup(worker: asyncio.Task[T], on_cancel: Callable[[], None] | None = None) -> T:
    """Do not let task cancellation race thread-owned files or release admission.

    AnyIO shields its own cancellation scopes; the task also shields direct
    asyncio cancellation, used by server shutdown and ASGI callers.
    """
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        if on_cancel is not None:
            on_cancel()
        with anyio.CancelScope(shield=True):
            while not worker.done():
                try:
                    await asyncio.shield(worker)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
        # Retrieve a worker failure even when the disconnected caller cannot use it.
        if not worker.cancelled():
            worker.exception()
        raise
