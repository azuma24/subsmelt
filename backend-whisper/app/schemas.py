from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

OutputFormat = Literal["srt", "vtt", "txt", "ass"]
PostAction = Literal["transcribe_only", "transcribe_and_translate"]


class SubtitleQualityOptions(BaseModel):
    max_line_length: int | None = None
    max_subtitle_duration: float | None = None
    merge_short_segments: bool = False


class AdvancedSttOptions(BaseModel):
    beam_size: int | None = None
    patience: float | None = None
    condition_on_previous_text: bool | None = None
    word_timestamps: bool | None = None
    initial_prompt: str | None = None
    speaker_diarization: bool = False
    bgm_separation: bool = False


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
    advanced_options: AdvancedSttOptions | None = None


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
    # GPU/VRAM fields — populated only when the request targets device=cuda.
    # Additive; default None so the CPU path response shape is unchanged.
    device: str | None = Field(default=None, alias="device")
    free_vram_mb: int | None = Field(default=None, alias="freeVramMb")
    required_vram_mb: int | None = Field(default=None, alias="requiredVramMb")
    recommended_vram_mb: int | None = Field(default=None, alias="recommendedVramMb")
    gpus: list[dict] | None = Field(default=None, alias="gpus")

    class Config:
        populate_by_name = True


class TranscribeResponse(BaseModel):
    ok: bool
    subtitle_path: str | None = None
    language: str | None = None
    segments: int = 0
    duration_seconds: float | None = None


class UploadTranscribeResponse(BaseModel):
    """Response for the upload transport (Model B, plan Phase 2).

    Unlike :class:`TranscribeResponse`, this carries the subtitle ``content`` as a
    string rather than a server-side ``subtitle_path`` — the client sent the
    media over the wire and writes the returned content to its own local output
    path, so no shared filesystem is involved.
    """

    ok: bool
    content: str
    language: str | None = None
    segments: int = 0
    duration_seconds: float | None = None
