"""Transcription + task routes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_auth
from ..config import Settings, get_settings
from ..pipeline.orchestrator import run_transcription
from ..pipeline.writer import SUPPORTED_FORMATS
from ..state.db import Task, get_store, new_task_id, options_to_json
from ..state.queue import get_queue

router = APIRouter(tags=["transcribe"])


class VadPayload(BaseModel):
    enabled: bool = True
    min_silence_ms: int = 500
    speech_pad_ms: int = 400
    threshold: float = 0.5


class UvrPayload(BaseModel):
    enabled: bool = False
    model_name: Optional[str] = None


class TranscribeRequest(BaseModel):
    video_path: str = Field(..., description="Absolute path to the video file.")
    output_path: str = Field(..., description="Where to write the resulting subtitle file.")
    model: str = "large-v3-turbo"
    language: Optional[str] = None
    task: str = "transcribe"       # or "translate"
    output_format: str = "srt"     # srt | vtt | txt
    beam_size: int = 5
    temperature: float = 0.0
    initial_prompt: Optional[str] = None
    vad: VadPayload = Field(default_factory=VadPayload)
    uvr: UvrPayload = Field(default_factory=UvrPayload)


class TaskIdResponse(BaseModel):
    task_id: str


@router.post(
    "/transcribe",
    response_model=TaskIdResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_auth)],
)
def submit_transcription(
    req: TranscribeRequest,
    settings: Settings = Depends(get_settings),
) -> TaskIdResponse:
    if req.output_format.lower() not in SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"output_format must be one of {sorted(SUPPORTED_FORMATS)}",
        )
    if req.task not in ("transcribe", "translate"):
        raise HTTPException(status_code=400, detail="task must be 'transcribe' or 'translate'")

    video = Path(req.video_path)
    if not video.is_absolute():
        raise HTTPException(status_code=400, detail="video_path must be absolute")
    if not video.exists():
        raise HTTPException(status_code=404, detail=f"video_path not found: {video}")

    output = Path(req.output_path)
    if not output.is_absolute():
        raise HTTPException(status_code=400, detail="output_path must be absolute")

    options: dict[str, Any] = {
        "model": req.model,
        "language": req.language,
        "task": req.task,
        "beam_size": req.beam_size,
        "temperature": req.temperature,
        "initial_prompt": req.initial_prompt,
        "vad": req.vad.model_dump(),
        "uvr": req.uvr.model_dump(),
    }

    store = get_store(settings.config_dir)
    task = Task(
        id=new_task_id(),
        kind="transcribe",
        status="queued",
        stage=None,
        progress=0.0,
        video_path=str(video),
        output_path=str(output),
        output_format=req.output_format.lower(),
        options_json=options_to_json(options),
    )
    store.create(task)
    q = get_queue(settings.max_concurrent)
    q.enqueue(task.id, lambda tid: run_transcription(tid, store))
    return TaskIdResponse(task_id=task.id)


class TaskView(BaseModel):
    id: str
    kind: str
    status: str
    stage: Optional[str] = None
    progress: float = 0.0
    error: Optional[str] = None
    video_path: Optional[str] = None
    output_path: Optional[str] = None
    output_format: Optional[str] = None
    model_kind: Optional[str] = None
    model_name: Optional[str] = None
    options: Optional[dict] = None
    created_at: float
    updated_at: float


def _task_to_view(task: Task) -> TaskView:
    options = None
    if task.options_json:
        try:
            options = json.loads(task.options_json)
        except json.JSONDecodeError:
            options = None
    return TaskView(
        id=task.id,
        kind=task.kind,
        status=task.status,
        stage=task.stage,
        progress=task.progress,
        error=task.error,
        video_path=task.video_path,
        output_path=task.output_path,
        output_format=task.output_format,
        model_kind=task.model_kind,
        model_name=task.model_name,
        options=options,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


@router.get(
    "/tasks",
    response_model=list[TaskView],
    dependencies=[Depends(require_auth)],
)
def list_tasks(
    kind: Optional[str] = None,
    limit: int = 200,
    settings: Settings = Depends(get_settings),
) -> list[TaskView]:
    store = get_store(settings.config_dir)
    return [_task_to_view(t) for t in store.list(kind=kind, limit=limit)]


@router.get(
    "/tasks/{task_id}",
    response_model=TaskView,
    dependencies=[Depends(require_auth)],
)
def get_task(
    task_id: str,
    settings: Settings = Depends(get_settings),
) -> TaskView:
    store = get_store(settings.config_dir)
    task = store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return _task_to_view(task)


@router.delete(
    "/tasks/{task_id}",
    dependencies=[Depends(require_auth)],
)
def cancel_task(
    task_id: str,
    settings: Settings = Depends(get_settings),
) -> dict:
    store = get_store(settings.config_dir)
    task = store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status in ("done", "error", "cancelled"):
        return {"ok": True, "status": task.status}
    store.request_cancel(task_id)
    # For queued tasks that haven't started yet, mark cancelled directly so the
    # subsmelt poller sees it immediately. The worker will also honour the flag
    # if it picks the task up.
    if task.status == "queued":
        store.update(task_id, status="cancelled", stage=None)
    return {"ok": True, "status": "cancelling"}
