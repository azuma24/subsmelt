from __future__ import annotations

import os
import stat

_MAX_SECRET_BYTES = 16 * 1024


class SecretFileError(ValueError):
    """A selected mounted secret file could not supply a usable credential."""


def _read_mounted_secret(variable: str, path: str) -> str:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError
            contents = stream.read(_MAX_SECRET_BYTES + 1)
        if len(contents) > _MAX_SECRET_BYTES:
            raise ValueError
        secret = contents.decode("utf-8-sig").strip()
        if not secret or any(char in secret for char in "\r\n\0"):
            raise ValueError
        return secret
    except (OSError, ValueError):
        raise SecretFileError(
            f"{variable} must point to a readable file containing one nonempty UTF-8 credential"
        ) from None


def secret_from_env(variable: str) -> str | None:
    """Resolve one explicitly supported environment credential before saved settings."""
    direct = os.environ.get(variable)
    if direct:
        return direct
    file_variable = f"{variable}_FILE"
    path = os.environ.get(file_variable)
    return _read_mounted_secret(file_variable, path) if path else None
