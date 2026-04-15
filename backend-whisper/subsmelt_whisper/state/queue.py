"""
Single-worker background queue.

GPU inference is the bottleneck, so we serialise work. A pool of worker threads
is used (default 1) that pull tasks from an in-memory queue and run them
through the pipeline orchestrator.
"""

from __future__ import annotations

import logging
import queue
import threading
import traceback
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

# A "runner" is any callable that takes a task_id and performs the work,
# updating the shared TaskStore as it goes. It should respect cancel requests.
TaskRunner = Callable[[str], None]


class TaskQueue:
    def __init__(self, workers: int = 1) -> None:
        self._q: "queue.Queue[tuple[str, TaskRunner] | None]" = queue.Queue()
        self._workers: list[threading.Thread] = []
        self._stop_event = threading.Event()
        self._workers_count = max(1, workers)

    def start(self) -> None:
        for i in range(self._workers_count):
            t = threading.Thread(
                target=self._loop, name=f"whisper-worker-{i}", daemon=True
            )
            t.start()
            self._workers.append(t)

    def stop(self, join: bool = False) -> None:
        self._stop_event.set()
        for _ in self._workers:
            self._q.put(None)
        if join:
            for t in self._workers:
                t.join(timeout=5)

    def enqueue(self, task_id: str, runner: TaskRunner) -> None:
        self._q.put((task_id, runner))

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            item = self._q.get()
            if item is None:
                return
            task_id, runner = item
            try:
                runner(task_id)
            except Exception:  # noqa: BLE001
                log.error("Task %s crashed:\n%s", task_id, traceback.format_exc())
            finally:
                self._q.task_done()


_QUEUE: Optional[TaskQueue] = None


def get_queue(workers: int = 1) -> TaskQueue:
    global _QUEUE
    if _QUEUE is None:
        _QUEUE = TaskQueue(workers=workers)
        _QUEUE.start()
    return _QUEUE


def shutdown_queue() -> None:
    global _QUEUE
    if _QUEUE is not None:
        _QUEUE.stop(join=True)
        _QUEUE = None
