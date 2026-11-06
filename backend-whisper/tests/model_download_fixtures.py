from __future__ import annotations

import os
import time
from pathlib import Path

from app import model_manager


def seed_whisper_metadata(path: Path) -> None:
    (path / "config.json").write_text("{}")
    (path / "vocabulary.json").write_text("[]")


def inline_download_attempt(operation: model_manager.ModelDownload) -> dict:
    """Run with the test's mocked Hub and tqdm imports in the current process."""
    events = []

    def emit(event: dict) -> None:
        if event["type"] == "progress":
            operation._progress(event)
        elif event["type"] != "activity":
            events.append(event)

    model_manager._download_in_process(operation.model, operation.cache_root, emit)
    return events[-1]


def stalled_download_worker(model, cache_root, sender):
    (cache_root / "worker.pid").write_text(str(os.getpid()))
    (cache_root / "model.bin.incomplete").write_bytes(b"resumable bytes")
    sender.send({"type": "progress", "pct": 20.0, "downloadedMb": 15.0, "totalMb": 75.0})
    time.sleep(60)


def retryable_download_worker(model, cache_root, sender):
    partial = cache_root / "model.bin.incomplete"
    if not partial.exists():
        partial.write_bytes(b"resumable bytes")
        sender.send({"type": "failed", "error": "connection reset", "retry": True})
        return
    snapshot = cache_root / "models--Systran--faster-whisper-tiny" / "snapshots" / "rev"
    snapshot.mkdir(parents=True)
    (snapshot / "model.bin").write_bytes(partial.read_bytes())
    seed_whisper_metadata(snapshot)
    sender.send({"type": "complete", "path": str(snapshot)})
