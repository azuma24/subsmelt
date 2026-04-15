"""Model catalog / download / delete routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..auth import require_auth
from ..config import Settings, get_settings
from ..pipeline.models import (
    cached_json,
    catalog_json,
    delete_cached,
    run_model_download,
)
from ..state.db import Task, get_store, new_task_id
from ..state.queue import get_queue

router = APIRouter(tags=["models"])


@router.get(
    "/models",
    dependencies=[Depends(require_auth)],
)
def list_models(settings: Settings = Depends(get_settings)) -> dict:
    cached = cached_json(settings.models_dir)
    catalog = catalog_json()
    return {
        "whisper": {
            "cached": cached["whisper"]["cached"],
            "catalog": catalog["whisper"]["catalog"],
        },
        "uvr": {
            "cached": cached["uvr"]["cached"],
            "catalog": catalog["uvr"]["catalog"],
        },
    }


class DownloadRequest(BaseModel):
    kind: str   # 'whisper' | 'uvr'
    name: str


class TaskIdResponse(BaseModel):
    task_id: str


@router.post(
    "/models/download",
    response_model=TaskIdResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_auth)],
)
def download_model(
    req: DownloadRequest,
    settings: Settings = Depends(get_settings),
) -> TaskIdResponse:
    if req.kind not in ("whisper", "uvr"):
        raise HTTPException(status_code=400, detail="kind must be 'whisper' or 'uvr'")
    if not req.name:
        raise HTTPException(status_code=400, detail="name is required")

    store = get_store(settings.config_dir)
    task = Task(
        id=new_task_id(),
        kind="download",
        status="queued",
        stage=None,
        progress=0.0,
        model_kind=req.kind,
        model_name=req.name,
    )
    store.create(task)
    q = get_queue(settings.max_concurrent)
    q.enqueue(task.id, lambda tid: run_model_download(tid, store))
    return TaskIdResponse(task_id=task.id)


@router.delete(
    "/models/{kind}/{name:path}",
    dependencies=[Depends(require_auth)],
)
def delete_model(
    kind: str,
    name: str,
    settings: Settings = Depends(get_settings),
) -> dict:
    if kind not in ("whisper", "uvr"):
        raise HTTPException(status_code=400, detail="kind must be 'whisper' or 'uvr'")
    try:
        removed = delete_cached(settings.models_dir, kind, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not removed:
        raise HTTPException(status_code=404, detail="Model not found in cache")
    return {"ok": True}
