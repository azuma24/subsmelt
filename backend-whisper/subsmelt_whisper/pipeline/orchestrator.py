"""
End-to-end transcription pipeline:

    extract audio  ─▶  [UVR]  ─▶  [VAD via faster-whisper]  ─▶  whisper  ─▶  writer

Progress is surfaced as a 0..1 value on the shared TaskStore with a named
``stage`` so the subsmelt UI can render a meaningful label.
"""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..config import get_settings
from ..state.db import Task, TaskStore
from . import audio, uvr, vad, whisper_runner, writer

log = logging.getLogger(__name__)


class Cancelled(Exception):
    """Raised by the orchestrator when a task was cancelled mid-run."""


def _fail_if_cancelled(store: TaskStore, task_id: str) -> None:
    if store.is_cancel_requested(task_id):
        raise Cancelled()


@contextmanager
def _tmp_workdir() -> Iterator[Path]:
    d = Path(tempfile.mkdtemp(prefix="subsmelt-whisper-"))
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


def run_transcription(task_id: str, store: TaskStore) -> None:
    settings = get_settings()
    task = store.get(task_id)
    if task is None:
        log.error("Task %s missing from store at run time", task_id)
        return

    options: dict[str, Any] = json.loads(task.options_json or "{}")
    video_path = Path(task.video_path or "")
    output_path = Path(task.output_path or "")
    output_format = (task.output_format or "srt").lower()

    if not video_path.exists():
        store.update(task_id, status="error", error=f"video_path not found: {video_path}")
        return

    store.update(task_id, status="running", stage="extracting", progress=0.0, error=None)
    store.clear_cancel(task_id)

    try:
        with _tmp_workdir() as workdir:
            _fail_if_cancelled(store, task_id)
            raw_wav = workdir / "audio.wav"
            audio.extract_audio(video_path, raw_wav)
            store.update(task_id, progress=0.05)

            _fail_if_cancelled(store, task_id)
            uvr_opts = options.get("uvr") or {}
            if uvr_opts.get("enabled"):
                store.update(task_id, stage="uvr", progress=0.10)
                vocals_wav = workdir / "vocals.wav"
                uvr.separate_vocals(
                    raw_wav,
                    vocals_wav,
                    model_name=uvr_opts.get("model_name") or uvr.DEFAULT_UVR_MODEL,
                    models_dir=settings.models_dir,
                )
                audio_for_whisper = vocals_wav
            else:
                audio_for_whisper = raw_wav
            store.update(task_id, progress=0.20)

            _fail_if_cancelled(store, task_id)
            vad_opts = vad.vad_from_request(options.get("vad"))
            store.update(task_id, stage="transcribing", progress=0.22)

            model = whisper_runner.load_model(
                options.get("model") or "large-v3-turbo",
                models_dir=settings.models_dir,
                device=settings.device,
                compute_type=settings.compute_type,
            )
            _fail_if_cancelled(store, task_id)

            segments_iter, duration = whisper_runner.transcribe(
                model,
                audio_for_whisper,
                language=options.get("language") or None,
                task=options.get("task") or "transcribe",
                beam_size=int(options.get("beam_size", 5)),
                temperature=float(options.get("temperature", 0.0)),
                initial_prompt=options.get("initial_prompt"),
                vad_filter=vad_opts.enabled,
                vad_parameters=vad_opts.to_whisper_params(),
            )

            collected: list[whisper_runner.Segment] = []
            for seg in segments_iter:
                _fail_if_cancelled(store, task_id)
                collected.append(seg)
                if duration > 0:
                    # 0.22 -> 0.92 range allocated to transcription progress.
                    pct = 0.22 + min(0.70, (seg.end / duration) * 0.70)
                    store.update(task_id, progress=round(pct, 4))

            _fail_if_cancelled(store, task_id)
            store.update(task_id, stage="writing", progress=0.95)
            serialised = writer.serialise(collected, output_format)
            writer.atomic_write(output_path, serialised)

            store.update(
                task_id,
                status="done",
                stage=None,
                progress=1.0,
                error=None,
            )
            log.info(
                "Transcription done: task=%s video=%s output=%s segments=%d",
                task_id, video_path, output_path, len(collected),
            )
    except Cancelled:
        store.update(task_id, status="cancelled", stage=None, error=None)
        log.info("Transcription cancelled: task=%s", task_id)
    except Exception as exc:  # noqa: BLE001
        log.exception("Transcription failed: task=%s", task_id)
        store.update(task_id, status="error", stage=None, error=str(exc))
