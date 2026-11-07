from __future__ import annotations

import http.client
import os
import shutil
import socket
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as DnsTimeoutError
from functools import cached_property, partial
from importlib.util import find_spec
from ipaddress import IPv6Address, ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Fetch remote media (YouTube etc.) via yt-dlp, then feed it through the existing
# upload transcription pipeline. yt-dlp is an OPTIONAL dependency — advertised
# only when importable so the feature is hidden until installed.

#: Env flag that fully disables the SSRF guard (operator truly wants to fetch
#: from internal hosts). Same var is read by app/main.py for the preflight /
#: run-anywhere unsafe override.
ALLOW_UNSAFE_ENV = "SUBSMELT_WHISPER_ALLOW_UNSAFE"


class UrlFetchUnavailableError(RuntimeError):
    """yt-dlp is not installed in this backend."""


class UrlFetchError(RuntimeError):
    """The URL could not be fetched (bad URL, network, unsupported site)."""


def url_fetch_available() -> bool:
    try:
        import yt_dlp  # type: ignore  # noqa: F401
    except Exception:
        return False
    return True


def _allow_unsafe() -> bool:
    """True when the operator explicitly disabled the SSRF guard."""
    return os.environ.get(ALLOW_UNSAFE_ENV, "0").strip() == "1"


# --- SSRF guard ---------------------------------------------------------------
# The frontend lets an operator paste a URL the backend downloads. On an
# unauthenticated install (see the main web app's auth gap) anything that can
# reach this backend could point it at an internal host. This guard rejects
# loopback, RFC1918, link-local (incl. the 169.254.169.254 metadata endpoint),
# unique-local and other non-public targets unless SUBSMELT_WHISPER_ALLOW_UNSAFE
# is explicitly set. Connections are made directly to checked DNS answers.

#: Hostnames that are unresolvable by design on the public internet. `.internal`,
#: `.local` and `.localhost` are RFC 6761/6762 reserved and are the common
#: split-horizon/DNS-rebinding vectors a name-based SSRF uses.
_RESERVED_HOSTNAME_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa")
_RESERVED_HOSTNAMES = {"localhost", "localhost.localdomain"}


def _internal_host_message(host: str) -> str:
    return (
        f"URL host {host!r} is not a public internet address (SSRF guard). "
        f"Set {ALLOW_UNSAFE_ENV}=1 to fetch from local/private hosts."
    )


def _is_public_ip(ip: str) -> bool:
    """True when ``ip`` is a globally-routable (public) address.

    IPv4-mapped IPv6 (``::ffff:127.0.0.1``) is unwrapped before the check so the
    vintage SSRF trick of hiding a private v4 behind a v6 literal is caught.
    """
    try:
        addr = ip_address(ip)
    except ValueError:
        return False
    if isinstance(addr, IPv6Address):
        if addr.is_site_local or addr.scope_id is not None:
            return False
        if addr.ipv4_mapped is not None:
            addr = addr.ipv4_mapped
    return bool(addr.is_global and not addr.is_multicast and not addr.is_reserved and not addr.is_unspecified)


def _validate_url(url: str, allow_unsafe: bool = False) -> str:
    """Validate the URL scheme/host and reject non-public targets.

    Deterministic and DNS-free: IP-literal hostnames are range-checked directly
    and reserved hostnames (``localhost``, ``*.local``, ``*.internal``) are
    rejected by name. Hostnames are resolved and checked when connecting. Returns the
    trimmed URL. Raises UrlFetchError on a bad URL or a guarded target.
    """
    u = (url or "").strip()
    # Only http(s); reject file://, data:, and other schemes (SSRF/footgun guard).
    if not (u.startswith("http://") or u.startswith("https://")):
        raise UrlFetchError("Only http(s) URLs are supported")

    try:
        parsed = urlparse(u)
        host = parsed.hostname or ""
        _ = parsed.port
    except ValueError as exc:
        raise UrlFetchError("Invalid URL host or port") from exc
    if not host:
        raise UrlFetchError("URL must include a host")

    if allow_unsafe:
        return u

    # IP-literal host (IPv4 or IPv6, urlparse strips the brackets) — check ranges.
    try:
        _ = ip_address(host)
        if not _is_public_ip(host):
            raise UrlFetchError(_internal_host_message(host))
        return u  # public IP literal — no DNS lookup needed
    except ValueError:
        pass  # not an IP literal — a hostname; check by reserved name below

    low = host.lower().rstrip(".")
    if low in _RESERVED_HOSTNAMES or low.endswith(_RESERVED_HOSTNAME_SUFFIXES):
        raise UrlFetchError(_internal_host_message(host))

    return u


DNS_LOOKUP_THREADS = 4
_DNS_POOL = ThreadPoolExecutor(max_workers=DNS_LOOKUP_THREADS, thread_name_prefix="dns-lookup")


def _resolve_host(host: str, timeout: float = 3.0) -> list[str]:
    """Resolve a hostname to its list of IP strings, bounded by ``timeout``.

    Runs the blocking ``socket.getaddrinfo`` in a worker thread so a slow DNS
    server can never hang a fetch indefinitely.
    """

    def _lookup() -> list[str]:
        seen: list[str] = []
        for info in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM):
            ip = str(info[4][0])
            if ip not in seen:
                seen.append(ip)
        return seen

    # One shared, bounded pool: a lookup that outlives its timeout keeps its
    # thread until the resolver returns, so a stalled resolver can tie up at
    # most DNS_LOOKUP_THREADS threads instead of one per request.
    lookup = _DNS_POOL.submit(_lookup)
    try:
        return lookup.result(timeout=timeout)
    except DnsTimeoutError as exc:
        lookup.cancel()
        raise TimeoutError(f"DNS lookup timed out for {host!r}") from exc


def _public_addresses(host: str, resolver: Callable[[str], list[str]] | None = None) -> list[str]:
    try:
        ip_address(host)
    except ValueError:
        try:
            ips = (resolver or _resolve_host)(host)
        except OSError as exc:
            raise UrlFetchError(f"Could not resolve URL host {host!r}") from exc
    else:
        ips = [host]

    if not ips:
        raise UrlFetchError(f"Could not resolve URL host {host!r}")
    if not all(_is_public_ip(ip) for ip in ips):
        raise UrlFetchError(_internal_host_message(host))
    return ips


def _connect_public(address, timeout, source_address):
    host, port = address
    for ip in _public_addresses(host):
        try:
            # Connect to this numeric address, keeping the original hostname
            # on the HTTPConnection for the Host header and TLS verification.
            return socket.create_connection((ip, port), timeout, source_address)
        except OSError as exc:
            last_error = exc
    raise last_error


_NATIVE_FORMAT = "[protocol~='^(https?|m3u8(_native)?|http_dash_segments(_generator)?)$']"


def _public_ydl_class():
    """Restrict this downloader instance before any extractor can send a request."""
    from yt_dlp import YoutubeDL
    from yt_dlp.downloader import get_suitable_downloader
    from yt_dlp.downloader.dash import DashSegmentsFD
    from yt_dlp.downloader.hls import HlsFD
    from yt_dlp.downloader.http import HttpFD
    from yt_dlp.networking._urllib import HTTPHandler, RedirectHandler, UrllibRH
    from yt_dlp.networking.exceptions import RequestError

    # Older extractors can launch PhantomJS to load webpages independently of
    # yt-dlp's request handler, including when invoked as a fallback.
    if shutil.which("phantomjs") and find_spec("yt_dlp.extractor.openload") is not None:
        raise UrlFetchError("Guarded URL fetching requires yt-dlp without its legacy PhantomJS helper")

    def connection(cls, *args, **kwargs):
        conn = cls(*args, **kwargs)
        conn._create_connection = _connect_public
        return conn

    class PublicHTTPHandler(HTTPHandler):
        def http_open(self, req):
            return self.do_open(partial(connection, http.client.HTTPConnection), req)

        def https_open(self, req):
            return self.do_open(partial(connection, http.client.HTTPSConnection), req, context=self._context)

    class PublicRedirectHandler(RedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            _validate_url(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    class PublicUrllibRH(UrllibRH):
        _SUPPORTED_URL_SCHEMES = ("http", "https")
        _SUPPORTED_PROXY_SCHEMES = ()

        def _create_instance(self, proxies, cookiejar, legacy_ssl_support=None):
            # Reuse yt-dlp's content decoding and redirect method/cookie
            # handling. Disable urllib's ambient proxies and other protocols.
            opener = urllib.request.OpenerDirector()
            for handler in (
                PublicHTTPHandler(context=self._make_sslcontext(legacy_ssl_support=legacy_ssl_support)),
                PublicRedirectHandler(),
                urllib.request.HTTPCookieProcessor(cookiejar),
                urllib.request.HTTPDefaultErrorHandler(),
                urllib.request.HTTPErrorProcessor(),
                urllib.request.UnknownHandler(),
            ):
                opener.add_handler(handler)
            return opener

        def _send(self, request):
            try:
                _validate_url(request.url)
                return super()._send(request)
            except UrlFetchError as exc:
                raise RequestError(str(exc)) from exc

    class PublicYoutubeDL(YoutubeDL):
        @cached_property
        def _request_director(self):
            return self.build_request_director([PublicUrllibRH])

        def dl(self, name, info, subtitle=False, test=False):
            downloader = get_suitable_downloader(info, self.params, to_stdout=(name == "-"))
            if downloader not in (HttpFD, HlsFD, DashSegmentsFD):
                raise UrlFetchError("This media requires a downloader outside the URL safety guard")
            return super().dl(name, info, subtitle=subtitle, test=test)

    return PublicYoutubeDL


#: Cap on a fetched media file. Matches the frontend's upload cap
#: (src/server/transcription/http-upload.ts MAX_UPLOAD_BYTES) so a URL fetch
#: cannot pull more onto the scratch disk than an upload could.
MAX_FETCH_BYTES = 5 * 1024 * 1024 * 1024


def _media_urls(info: dict) -> list[str]:
    """Known result URLs for early rejection before starting the media download."""
    urls = [info.get("webpage_url"), info.get("url")]
    for fmt in info.get("requested_formats") or []:
        urls.extend(fmt.get(field) for field in ("url", "manifest_url", "fragment_base_url"))
    return [u for u in urls if isinstance(u, str) and u]


def _assert_media_hosts_public(info: dict, allow_unsafe: bool) -> None:
    """Re-run the SSRF guard on the probed result: the typed URL may have
    redirected, or the extractor may hand back media on another host."""
    if allow_unsafe:
        return
    for media_url in _media_urls(info):
        try:
            _validate_url(media_url)
            _public_addresses(urlparse(media_url).hostname)
        except UrlFetchError as exc:
            raise UrlFetchError(f"Media URL {media_url!r} refused: {exc}") from exc


def _assert_within_size_cap(info: dict) -> None:
    """Refuse up front when the probe already reports a size over the cap; the
    yt-dlp ``max_filesize`` option covers sizes only known once the download starts."""
    formats = info.get("requested_formats") or [info]
    total = sum(int(fmt.get("filesize") or fmt.get("filesize_approx") or 0) for fmt in formats)
    if total > MAX_FETCH_BYTES:
        raise UrlFetchError(f"Media is about {total >> 20} MB, over the {MAX_FETCH_BYTES >> 20} MB fetch limit")


def _abort_over_cap(progress: dict) -> None:
    """Progress hook: yt-dlp's ``max_filesize`` only guards plain HTTP downloads
    (it compares Content-Length); fragmented HLS/DASH streams never see it, so
    also stop on the bytes actually received."""
    if int(progress.get("downloaded_bytes") or 0) > MAX_FETCH_BYTES:
        raise UrlFetchError(f"Download exceeded the {MAX_FETCH_BYTES >> 20} MB fetch limit")


def _assert_single_media(info: Any) -> None:
    """This endpoint fetches one file; a playlist or channel would fetch every entry."""
    if not info:
        raise UrlFetchError("No media found at URL")
    if info.get("_type") in ("playlist", "multi_video"):
        raise UrlFetchError("URL points at a playlist or channel; paste the URL of a single video")


def download_url(url: str, dest_dir: Path) -> Path:
    """Download the best audio (fallback best) for ``url`` into ``dest_dir``.

    Probes the URL first (no download) so a playlist can be refused before any
    entry is fetched, then downloads from the probed result.

    Returns the path to the downloaded file. Raises UrlFetchUnavailableError if
    yt-dlp is absent, UrlFetchError on a bad URL, a guarded (SSRF) target, a
    playlist, an oversized file or a fetch failure.
    """
    allow_unsafe = _allow_unsafe()
    u = _validate_url(url, allow_unsafe)

    try:
        import yt_dlp  # type: ignore
    except Exception as exc:
        raise UrlFetchUnavailableError("yt-dlp is not installed in this backend") from exc

    opts: Any = {
        "outtmpl": str(dest_dir / "%(id)s.%(ext)s"),
        # Keep this endpoint scoped to supported sites.
        "allowed_extractors": ["default", "-generic"],
        "noplaylist": True,
        # Leave playlist entries unresolved during the probe: a channel URL would
        # otherwise fetch metadata for every video before being refused.
        "extract_flat": "in_playlist",
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "restrictfilenames": True,
        "max_filesize": MAX_FETCH_BYTES,
        "progress_hooks": [_abort_over_cap],
    }
    try:
        downloader = yt_dlp.YoutubeDL if allow_unsafe else _public_ydl_class()
        if not allow_unsafe:
            opts.update(
                proxy="",
                external_downloader={"default": "native"},
                format=f"bestaudio{_NATIVE_FORMAT}/best{_NATIVE_FORMAT}",
                check_formats=False,
                fixup="never",
                # Native HLS can fall back to FFmpeg for unsupported manifests.
                # Keep that fallback from launching an unguarded network client.
                ffmpeg_location=str(dest_dir / ".disabled-ffmpeg" / "ffmpeg"),
            )
        with downloader(opts) as ydl:
            info = ydl.extract_info(u, download=False)
            _assert_single_media(info)
            _assert_media_hosts_public(info, allow_unsafe)
            _assert_within_size_cap(info)
            ydl.process_ie_result(info, download=True)
            produced = Path(ydl.prepare_filename(info))
    except UrlFetchError:
        raise
    except Exception as exc:
        raise UrlFetchError(f"Failed to fetch media from URL: {exc}") from exc

    if produced.exists():
        return produced
    # Post-processing can change the extension; fall back to the newest file.
    files = sorted((p for p in dest_dir.glob("*") if p.is_file()), key=lambda p: p.stat().st_mtime)
    if not files:
        # yt-dlp skips (rather than fails) a file over max_filesize.
        raise UrlFetchError(f"Download produced no file (media over {MAX_FETCH_BYTES >> 20} MB is refused)")
    return files[-1]
