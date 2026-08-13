"""URL-fetch unit tests (no network, no yt-dlp required)."""

import unittest

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
