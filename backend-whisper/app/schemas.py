from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

OutputFormat = Literal["srt", "vtt", "txt"]
PostAction = Literal["transcribe_only", "transcribe_and_translate"]


class SubtitleQualityOptions(BaseModel):
    max_line_length: int | None = None
    max_subtitle_duration: float | None = None
    merge_short_segments: bool = False


class TranscribeRequest(BaseModel):
    input_path: str
    output_format: OutputFormat = "srt"
    model: str = "small"
    language: str = "auto"
    device: str = "cpu"
    compute_type: str = "int8"
    use_vad: bool = True
    post_action: PostAction = "transcribe_only"
    allow_unsafe: bool = False
    subtitle_quality: SubtitleQualityOptions | None = None


class HealthResponse(BaseModel):
    ok: bool = True
    service: str = "subsmelt-whisper"
    ffmpeg: bool
    total_ram_mb: int = Field(alias="totalRamMb")
    available_ram_mb: int = Field(alias="availableRamMb")
    capabilities: dict
    model_cache: dict | None = Field(default=None, alias="modelCache")

    class Config:
        populate_by_name = True


class PreflightResponse(BaseModel):
    ok: bool
    safe: bool
    code: str
    available_ram_mb: int = Field(alias="availableRamMb")
    required_ram_mb: int = Field(alias="requiredRamMb")
    recommended_ram_mb: int = Field(alias="recommendedRamMb")
    suggested_model: str | None = Field(default=None, alias="suggestedModel")
    ffmpeg_available: bool = Field(alias="ffmpegAvailable")
    disk_available_mb: int = Field(alias="diskAvailableMb")
    required_disk_mb: int = Field(alias="requiredDiskMb")
    model_cache: dict | None = Field(default=None, alias="modelCache")

    class Config:
        populate_by_name = True


class TranscribeResponse(BaseModel):
    ok: bool
    subtitle_path: str | None = None
    language: str | None = None
    segments: int = 0
    duration_seconds: float | None = None
