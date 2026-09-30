"""URL-fetch unit tests (no network, no yt-dlp required)."""

import socket
import time
import unittest
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
