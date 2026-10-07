"""The models this backend manages, one descriptor per model.

A descriptor answers every question about a model that is not "how do I run
it": which engine, where its weights come from, how much memory it needs and
which languages and options it accepts. The engine registry in transcribe.py
answers the running part. Nothing else should hard-code a model id.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

from .nemotron_languages import NEMOTRON_SHORT_CODES

Engine = Literal["whisper", "nemotron"]


@dataclass(frozen=True)
class Supports:
    prompt: bool
    beam_size: bool
    condition_on_previous_text: bool
    vad: bool
    compute_type: bool
    word_timestamps: bool
    translate_task: bool


@dataclass(frozen=True)
class MemoryMb:
    required: int
    recommended: int


@dataclass(frozen=True)
class ModelDescriptor:
    id: str
    engine: Engine
    label: str
    # None for Whisper: the repo comes from faster-whisper's own registry.
    repo_id: str | None
    # The single file to download; None means the whole snapshot.
    weights_file: str | None
    size_mb: int
    ram_mb: MemoryMb
    vram_mb: MemoryMb
    languages: Literal["all"] | tuple[str, ...]
    supports: Supports

    def accepts_language(self, short: str) -> bool:
        if self.languages == "all":
            return True
        return short.lower() in {code.lower() for code in self.languages}


_WHISPER_SUPPORTS = Supports(
    prompt=True,
    beam_size=True,
    condition_on_previous_text=True,
    vad=True,
    compute_type=True,
    word_timestamps=True,
    translate_task=False,
)
_NEMOTRON_SUPPORTS = Supports(
    prompt=False,
    beam_size=False,
    condition_on_previous_text=False,
    vad=False,
    compute_type=False,
    word_timestamps=True,
    translate_task=False,
)


def _whisper(
    model_id: str, size_mb: int, ram: tuple[int, int], vram: tuple[int, int], languages="all"
) -> ModelDescriptor:
    return ModelDescriptor(
        id=model_id,
        engine="whisper",
        label=f"Whisper {model_id}",
        repo_id=None,
        weights_file=None,
        size_mb=size_mb,
        ram_mb=MemoryMb(*ram),
        vram_mb=MemoryMb(*vram),
        languages=languages,
        supports=_WHISPER_SUPPORTS,
    )


# Sizes are the approximate CTranslate2 int8/float16 download sizes; the real
# on-disk size replaces them once a model is present.
MODELS: tuple[ModelDescriptor, ...] = (
    _whisper("tiny", 75, (2048, 4096), (1024, 2048)),
    _whisper("base", 145, (3072, 4096), (1536, 2048)),
    _whisper("small", 484, (4096, 8192), (2048, 4096)),
    _whisper("medium", 1530, (8192, 16384), (5120, 8192)),
    _whisper("large-v1", 3090, (16384, 32768), (10240, 12288)),
    _whisper("large-v2", 3090, (16384, 32768), (10240, 12288)),
    _whisper("large-v3", 3090, (16384, 32768), (10240, 12288)),
    _whisper("distil-large-v3", 1510, (12288, 24576), (6144, 8192), languages=("en",)),
    _whisper("large-v3-turbo", 1620, (12288, 24576), (6144, 8192)),
    ModelDescriptor(
        id="nemotron-3.5-asr",
        engine="nemotron",
        label="Nemotron 3.5 ASR",
        repo_id="nvidia/nemotron-3.5-asr-streaming-0.6b",
        weights_file="nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
        size_mb=742,
        ram_mb=MemoryMb(3072, 4096),
        vram_mb=MemoryMb(1536, 2048),
        languages=NEMOTRON_SHORT_CODES,
        supports=_NEMOTRON_SUPPORTS,
    ),
)

ADVERTISED_MODELS: tuple[str, ...] = tuple(model.id for model in MODELS)
DEFAULT_MODEL_ID = "small"

_BY_ID: dict[str, ModelDescriptor] = {model.id: model for model in MODELS}

# Smaller models to suggest when memory is short, per engine. Nemotron has no
# smaller sibling and a Whisper model is never a substitute for it.
_DOWNGRADE_CANDIDATES: dict[str, tuple[str, ...]] = {
    "whisper": ("small", "base", "tiny"),
    "nemotron": (),
}


def descriptor_for(model_id: str) -> ModelDescriptor | None:
    """The descriptor for a managed id; None for local paths and unknown ids."""
    return _BY_ID.get((model_id or "").strip().lower())


def downgrade_candidates(model_id: str) -> tuple[ModelDescriptor, ...]:
    descriptor = descriptor_for(model_id)
    engine = descriptor.engine if descriptor else "whisper"
    return tuple(_BY_ID[candidate] for candidate in _DOWNGRADE_CANDIDATES[engine])


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


def to_wire(descriptor: ModelDescriptor, available: bool, reason: str | None) -> dict:
    """The camelCase JSON the client reads from ``capabilities.modelInfo``."""
    languages = descriptor.languages if descriptor.languages == "all" else list(descriptor.languages)
    return {
        "id": descriptor.id,
        "engine": descriptor.engine,
        "label": descriptor.label,
        "sizeMb": descriptor.size_mb,
        "requiredRamMb": descriptor.ram_mb.required,
        "requiredVramMb": descriptor.vram_mb.required,
        "languages": languages,
        "supports": {_camel(key): value for key, value in asdict(descriptor.supports).items()},
        "available": available,
        "unavailableReason": reason,
    }
