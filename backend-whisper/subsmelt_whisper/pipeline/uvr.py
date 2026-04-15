"""UVR-style BGM / vocal separation via the audio-separator package."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

DEFAULT_UVR_MODEL = "UVR-MDX-NET-Inst_HQ_3.onnx"


def separate_vocals(
    in_wav: Path,
    out_wav: Path,
    model_name: str,
    models_dir: Path,
) -> Path:
    """
    Run UVR to produce a vocals-only track. Falls through to copying the input
    if audio-separator is unavailable (e.g. CPU-only smoke test), so the rest
    of the pipeline keeps working.
    """
    try:
        from audio_separator.separator import Separator  # type: ignore
    except Exception as exc:
        log.warning("audio-separator not importable (%s); skipping UVR", exc)
        import shutil as _shutil

        _shutil.copy2(in_wav, out_wav)
        return out_wav

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    model = model_name or DEFAULT_UVR_MODEL
    separator = Separator(
        output_dir=str(out_wav.parent),
        model_file_dir=str(models_dir / "uvr"),
        output_single_stem="Vocals",
    )
    log.info("UVR separation: %s -> %s (model=%s)", in_wav, out_wav, model)
    separator.load_model(model_filename=model)
    produced = separator.separate(str(in_wav))
    # audio-separator returns a list of output files; pick the vocals one.
    vocals: Optional[Path] = None
    for p in produced:
        path = Path(p)
        if "vocal" in path.stem.lower():
            vocals = path
            break
    if vocals is None and produced:
        vocals = Path(produced[0])
    if vocals is None:
        raise RuntimeError("UVR produced no output files")
    # Move / rename to the canonical output path.
    vocals.replace(out_wav)
    return out_wav
