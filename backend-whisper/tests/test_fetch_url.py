"""URL-fetch unit tests (no network, no yt-dlp required)."""

import os
import socket
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from app import fetch_url


class FetchUrlTests(unittest.TestCase):
    def test_available_returns_bool(self):
        self.assertIsInstance(fetch_url.url_fetch_available(), bool)

    def test_validate_accepts_http_and_https(self):
        self.assertEqual(fetch_url._validate_url("https://x/y"), "https://x/y")
        self.assertEqual(fetch_url._validate_url("  http://x  "), "http://x")

    def test_validate_rejects_other_schemes(self):
        for bad in ["ftp://x", "file:///etc/passwd", "data:text/plain,hi", "", "x.com"]:
            with self.assertRaises(fetch_url.UrlFetchError):
                fetch_url._validate_url(bad)

    def test_validate_rejects_private_ip_literals(self):
        for bad in [
            "http://127.0.0.1/foo",
            "http://10.0.0.1/x",
            "http://192.168.1.1/x",
            "http://172.16.0.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/x",
            "http://[::ffff:127.0.0.1]/x",
        ]:
            with self.assertRaises(fetch_url.UrlFetchError):
                fetch_url._validate_url(bad)

    def test_validate_rejects_reserved_hostnames(self):
        for bad in ["http://localhost/x", "http://foo.local/x", "http://srv.internal/x"]:
            with self.assertRaises(fetch_url.UrlFetchError):
                fetch_url._validate_url(bad)

    def test_validate_allows_public_targets(self):
        self.assertEqual(fetch_url._validate_url("https://example.com/x"), "https://example.com/x")
        self.assertEqual(fetch_url._validate_url("http://8.8.8.8/x"), "http://8.8.8.8/x")

    def test_validate_allow_unsafe_bypasses_guard(self):
        self.assertEqual(fetch_url._validate_url("http://127.0.0.1/x", allow_unsafe=True), "http://127.0.0.1/x")
        self.assertEqual(fetch_url._validate_url("http://localhost/x", allow_unsafe=True), "http://localhost/x")

    def test_hostname_public_blocks_private_resolution(self):
        def resolver(host):
            return ["192.168.1.5"]
        with self.assertRaises(fetch_url.UrlFetchError):
            fetch_url._assert_hostname_public("http://internal.example/x", resolver=resolver)
        # allow_unsafe bypasses the DNS guard too.
        fetch_url._assert_hostname_public("http://internal.example/x", allow_unsafe=True, resolver=resolver)

    def test_hostname_public_allows_public_resolution(self):
        def resolver(host):
            return ["8.8.8.8", "1.1.1.1"]
        # Nothing raised.
        fetch_url._assert_hostname_public("http://public.example/x", resolver=resolver)

    def test_hostname_public_swallows_resolution_failure(self):
        def resolver(host):
            raise OSError("no such host")
        # A resolution failure is not an SSRF signal — do not block the fetch.
        fetch_url._assert_hostname_public("http://maybe.example/x", resolver=resolver)

    def test_resolve_host_timeout_is_not_defeated_by_a_slow_lookup(self):
        def slow_getaddrinfo(*args, **kwargs):
            time.sleep(2.0)
            return []

        with mock.patch.object(socket, "getaddrinfo", slow_getaddrinfo):
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                fetch_url._resolve_host("slow.example", timeout=0.2)
            self.assertLess(time.monotonic() - started, 1.0)

    def test_download_without_ytdlp_raises_unavailable(self):
        if fetch_url.url_fetch_available():
            self.skipTest("yt-dlp installed; unavailable path not exercised")
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(fetch_url.UrlFetchUnavailableError):
                fetch_url.download_url("https://example.com/v", Path(tmp))


if __name__ == "__main__":
    unittest.main()


class _FakeYoutubeDL:
    """Stands in for yt_dlp.YoutubeDL: returns a canned info dict and records calls."""

    info: dict = {}
    calls: list = []
    last_opts: dict = {}

    def __init__(self, opts):
        self.opts = opts
        type(self).last_opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        type(self).calls.append(("extract_info", url, download))
        return type(self).info

    def process_ie_result(self, info, download=True):
        type(self).calls.append(("process_ie_result", download))
        Path(self.prepare_filename(info)).write_bytes(b"audio")
        return info

    def prepare_filename(self, info):
        return self.opts["outtmpl"].replace("%(id)s", info["id"]).replace("%(ext)s", info["ext"])


class DownloadUrlTests(unittest.TestCase):
    def setUp(self):
        fake = types.ModuleType("yt_dlp")
        fake.YoutubeDL = _FakeYoutubeDL
        _FakeYoutubeDL.calls = []
        self._patchers = [
            mock.patch.dict(sys.modules, {"yt_dlp": fake}),
            mock.patch.dict(os.environ, {fetch_url.ALLOW_UNSAFE_ENV: "0"}),
            # Keep CI offline: every hostname "resolves" to a public address.
            mock.patch.object(fetch_url, "_resolve_host", lambda host, timeout=3.0: ["93.184.216.34"]),
        ]
        for patcher in self._patchers:
            patcher.start()
        self._tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()
        for patcher in reversed(self._patchers):
            patcher.stop()

    def _downloaded(self) -> bool:
        return any(call[0] == "process_ie_result" for call in _FakeYoutubeDL.calls)

    def test_playlist_and_channel_urls_are_refused_without_downloading(self):
        _FakeYoutubeDL.info = {"_type": "playlist", "id": "PL1", "entries": [{"id": "a"}, {"id": "b"}]}
        with self.assertRaises(fetch_url.UrlFetchError) as ctx:
            fetch_url.download_url("https://example.com/playlist?list=PL1", self.dest)
        self.assertIn("playlist", str(ctx.exception))
        self.assertFalse(self._downloaded())

    def test_probe_does_not_resolve_playlist_entries(self):
        _FakeYoutubeDL.info = {"id": "v1", "ext": "m4a", "webpage_url": "https://example.com/v1"}
        fetch_url.download_url("https://example.com/v1", self.dest)
        self.assertEqual(_FakeYoutubeDL.last_opts["extract_flat"], "in_playlist")
        self.assertTrue(_FakeYoutubeDL.last_opts["noplaylist"])
