from __future__ import annotations

from pathlib import Path
from typing import Any

# Fetch remote media (YouTube etc.) via yt-dlp, then feed it through the existing
# upload transcription pipeline. yt-dlp is an OPTIONAL dependency — advertised
# only when importable so the feature is hidden until installed.


class UrlFetchUnavailableError(RuntimeError):
    """yt-dlp is not installed in this backend."""


class UrlFetchError(RuntimeError):
    """The URL could not be fetched (bad URL, network, unsupported site)."""


def url_fetch_available() -> bool:
    try:
        import yt_dlp  # type: ignore  # noqa: F401
    except Exception:  # noqa: BLE001 - any import failure means unavailable
        return False
    return True


def _validate_url(url: str) -> str:
    u = (url or "").strip()
    # Only http(s); reject file://, data:, and other schemes (SSRF/footgun guard).
    if not (u.startswith("http://") or u.startswith("https://")):
        raise UrlFetchError("Only http(s) URLs are supported")
    return u


def download_url(url: str, dest_dir: Path) -> Path:
    """Download the best audio (fallback best) for ``url`` into ``dest_dir``.

    Returns the path to the downloaded file. Raises UrlFetchUnavailableError if
    yt-dlp is absent, UrlFetchError on a bad URL or fetch failure.
    """
    u = _validate_url(url)
    try:
        import yt_dlp  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise UrlFetchUnavailableError("yt-dlp is not installed in this backend") from exc

    opts: dict[str, Any] = {
        "outtmpl": str(dest_dir / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "restrictfilenames": True,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(u, download=True)
            produced = Path(ydl.prepare_filename(info))
    except Exception as exc:  # noqa: BLE001 - surface a clean message
        raise UrlFetchError(f"Failed to fetch media from URL: {exc}") from exc

    if produced.exists():
        return produced
    # Post-processing can change the extension; fall back to the newest file.
    files = sorted((p for p in dest_dir.glob("*") if p.is_file()), key=lambda p: p.stat().st_mtime)
    if not files:
        raise UrlFetchError("Download produced no file")
    return files[-1]
