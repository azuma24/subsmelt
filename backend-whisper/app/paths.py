from __future__ import annotations

import os
import shutil
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4


class SubtitlePublishError(RuntimeError):
    """The output path cannot be used for shared subtitle publication."""


def output_path_for(input_path: Path, language: str, output_format: str) -> Path:
    # Auto-detected source subtitles should attach back to the video during scanning.
    # Use Movie.srt instead of Movie.auto.srt because the scanner only treats known
    # language suffixes as removable video-name suffixes.
    if not language or language == "auto":
        return input_path.with_suffix(f".{output_format}")
    return input_path.with_name(f"{input_path.stem}.{language}.{output_format}")


@contextmanager
def _open_output_directory(path: Path) -> Iterator[int | None]:
    if os.name == "nt":
        # Python's directory-relative operations are unavailable on Windows.
        if path.resolve(strict=True) != path:
            raise SubtitlePublishError("Subtitle directory changed after media path validation")
        yield None
        return

    # Shared API requests already resolved the input under the media root.
    # Walk that canonical path without following links installed afterward.
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(path.anchor, flags)
    try:
        for part in path.parts[1:]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def publish_transcript(rendered: Path, target: Path) -> None:
    """Atomically publish an already rendered subtitle beside the source media."""
    if os.name == "nt" and ":" in target.name:
        raise SubtitlePublishError("Invalid subtitle filename")

    with _open_output_directory(target.parent) as dir_fd:
        tmp = target.with_name(f".subsmelt-{uuid4().hex}.tmp")
        name = target.name if dir_fd is not None else str(target)
        staged = tmp.name if dir_fd is not None else str(tmp)
        try:
            existing = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None and (
            not stat.S_ISREG(existing.st_mode)
            or existing.st_nlink > 1
            or getattr(existing, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            raise SubtitlePublishError("Subtitle output path is a link or is not a regular file")

        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        fd = os.open(staged, flags, 0o600 if existing else 0o666, dir_fd=dir_fd)
        try:
            with os.fdopen(fd, "wb") as output, rendered.open("rb") as source:
                shutil.copyfileobj(source, output)
                if existing is not None and dir_fd is not None:
                    os.fchmod(output.fileno(), existing.st_mode & 0o777)
            if dir_fd is None and target.parent.resolve(strict=True) != target.parent:
                raise SubtitlePublishError("Subtitle directory changed before publication")
            # Replacing a directory entry never opens the destination file.
            os.replace(staged, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        finally:
            try:
                os.unlink(staged, dir_fd=dir_fd)
            except FileNotFoundError:
                pass
