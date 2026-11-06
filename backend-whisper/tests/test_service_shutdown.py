"""Stopping the server while a stream is open.

Restarting the Windows service hung: SvcStop asks uvicorn to exit, but
uvicorn waited without limit for the open /models/download stream, and the
stream's worker ran on asyncio's default executor, whose threads the
interpreter joins before the process may exit. A download that never ended
kept the service in STOP_PENDING for good.
"""

import socket
import tempfile
import threading
import time
import unittest
from unittest import mock

import httpx
import uvicorn
from model_download_fixtures import stalled_download_worker

import run_server
from app import model_manager


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ShutdownWithAnOpenStreamTests(unittest.TestCase):
    def test_stop_returns_while_a_download_stream_never_ends(self):
        import app.main as main

        started = threading.Event()
        operations: list[str] = []

        config = run_server.ServerConfig(
            host="127.0.0.1",
            port=_free_port(),
            model_dir=None,
            token=None,
            media_root=None,
            ffmpeg=None,
            log_level="warning",
            log_file=None,
            nemo_speech=None,
            version=None,
        )
        with (
            tempfile.TemporaryDirectory() as cache_root,
            mock.patch.dict("os.environ", {"HF_HOME": cache_root, "SUBSMELT_WHISPER_TOKEN": ""}),
            mock.patch.object(run_server, "SHUTDOWN_GRACE_SECONDS", 1),
            mock.patch.object(model_manager, "_download_worker", stalled_download_worker),
        ):
            server = uvicorn.Server(uvicorn.Config(main.app, **run_server.uvicorn_kwargs(config, False)))
            serving = threading.Thread(target=server.run, daemon=True)
            serving.start()
            deadline = time.monotonic() + 10
            while not server.started and time.monotonic() < deadline:
                time.sleep(0.05)

            def open_stream():
                try:
                    with httpx.stream(
                        "POST", f"http://127.0.0.1:{config.port}/models/download", json={"model": "tiny"}, timeout=30
                    ) as response:
                        operations.append(response.headers["X-Model-Download-Id"])
                        for _ in response.iter_lines():
                            started.set()
                except httpx.HTTPError:
                    pass

            threading.Thread(target=open_stream, daemon=True).start()
            try:
                self.assertTrue(started.wait(10), "the download stream never started")
            finally:
                server.should_exit = True
                serving.join(timeout=10)

        self.assertFalse(serving.is_alive(), "the server did not stop while a stream was open")
        self.assertEqual(model_manager.find_model_download(operations[0])["status"], "cancelled")

    def test_the_grace_period_is_bounded(self):
        config = run_server.ServerConfig(
            host="0.0.0.0",
            port=8001,
            model_dir=None,
            token=None,
            media_root=None,
            ffmpeg=None,
            log_level="info",
            log_file=None,
            nemo_speech=None,
            version=None,
        )
        grace = run_server.uvicorn_kwargs(config, True)["timeout_graceful_shutdown"]
        self.assertGreater(grace, 0)
        # The SCM waits about 30 s on STOP_PENDING before calling a service hung.
        self.assertLess(grace, 30)


if __name__ == "__main__":
    unittest.main()
