from __future__ import annotations

from pathlib import Path


def output_path_for(input_path: Path, language: str, output_format: str) -> Path:
    # Auto-detected source subtitles should attach back to the video during scanning.
    # Use Movie.srt instead of Movie.auto.srt because the scanner only treats known
    # language suffixes as removable video-name suffixes.
    if not language or language == "auto":
        return input_path.with_suffix(f".{output_format}")
    return input_path.with_name(f"{input_path.stem}.{language}.{output_format}")
