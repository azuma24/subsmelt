from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException

from .preflight import (
    assert_path_under_media,
    available_ram_mb,
    disk_free_mb,
    evaluate_disk_safety,
    evaluate_model_safety,
    ffmpeg_available,
    total_ram_mb,
)
from .schemas import HealthResponse, PreflightResponse, TranscribeRequest, TranscribeResponse
from .transcribe import fake_transcribe_for_tests, run_faster_whisper

MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "/media")
ALLOW_UNSAFE = os.environ.get("SUBSMELT_WHISPER_ALLOW_UNSAFE", "0") == "1"
USE_FAKE_TRANSCRIBE = os.environ.get("SUBSMELT_WHISPER_FAKE", "0") == "1"

app = FastAPI(title="Subsmelt Whisper Backend", version="0.1.0")


def capabilities() -> dict:
    return {
        "models": ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"],
        "devices": ["cpu"],
        "computeTypes": ["int8", "float32"],
        "outputFormats": ["srt", "vtt", "txt"],
        "vad": True,
    }


@app.get("/health", response_model=HealthResponse, response_model_by_alias=True)
def health() -> HealthResponse:
    return HealthResponse(
        ffmpeg=ffmpeg_available(),
        total_ram_mb=total_ram_mb(),
        available_ram_mb=available_ram_mb(),
        capabilities=capabilities(),
    )


def preflight_result(request: TranscribeRequest) -> PreflightResponse:
    input_path = assert_path_under_media(request.input_path, MEDIA_ROOT)
    free_ram = available_ram_mb()
    safety = evaluate_model_safety(request.model, free_ram)
    ffmpeg_ok = ffmpeg_available()
    disk_mb = disk_free_mb(input_path.parent if input_path.exists() else Path(MEDIA_ROOT))
    input_size_mb = int(input_path.stat().st_size / 1024 / 1024) if input_path.exists() else 0
    disk_safety = evaluate_disk_safety(input_size_mb, disk_mb)
    safe = bool(safety["safe"] and ffmpeg_ok and disk_safety["safe"])
    code = (
        safety["code"] if not safety["safe"]
        else "ffmpeg_missing" if not ffmpeg_ok
        else disk_safety["code"] if not disk_safety["safe"]
        else "ok"
    )
    return PreflightResponse(
        ok=safe,
        safe=safe,
        code=code,
        available_ram_mb=safety["available_ram_mb"],
        required_ram_mb=safety["required_ram_mb"],
        recommended_ram_mb=safety["recommended_ram_mb"],
        suggested_model=safety["suggested_model"],
        ffmpeg_available=ffmpeg_ok,
        disk_available_mb=disk_mb,
        required_disk_mb=disk_safety["required_disk_mb"],
    )


@app.post("/preflight", response_model=PreflightResponse, response_model_by_alias=True)
def preflight(request: TranscribeRequest) -> PreflightResponse:
    try:
        return preflight_result(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "path_not_allowed", "message": str(exc)}) from exc


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(request: TranscribeRequest) -> TranscribeResponse:
    try:
        input_path = assert_path_under_media(request.input_path, MEDIA_ROOT)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "path_not_allowed", "message": str(exc)}) from exc

    result = preflight_result(request)
    if not result.safe and not (ALLOW_UNSAFE or request.allow_unsafe):
        raise HTTPException(status_code=422, detail={
            "code": result.code,
            "message": f"Transcription preflight failed: {result.code}",
            "availableRamMb": result.available_ram_mb,
            "requiredRamMb": result.required_ram_mb,
            "suggestedModel": result.suggested_model,
        })

    if not input_path.exists():
        raise HTTPException(status_code=404, detail={"code": "input_missing", "message": "Input media file does not exist"})

    try:
        if USE_FAKE_TRANSCRIBE:
            return fake_transcribe_for_tests(input_path, request)
        return run_faster_whisper(request, input_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"code": "transcription_failed", "message": str(exc)}) from exc
