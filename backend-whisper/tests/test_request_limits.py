"""Exercise admission at the HTTP boundary without GPU or real media work."""

import asyncio
import json
import os
import threading
import unittest
from pathlib import Path
from unittest import mock

from starlette.requests import ClientDisconnect

import app.main as main
from app.admission import Admission, current_reservation

TRANSCRIBE_ROUTES = (
    "/transcribe",
    "/transcribe/stream",
    "/transcribe/upload",
    "/transcribe/upload/stream",
    "/transcribe/url/stream",
)
JSON_ROUTES = ("/preflight", "/models/download", "/transcribe", "/transcribe/stream", "/transcribe/url/stream")


def multipart():
    return (
        b'--x\r\nContent-Disposition: form-data; name="request"\r\n\r\n{"model":"small"}\r\n'
        b'--x\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\n'
        b"Content-Type: audio/wav\r\n\r\nfake audio\r\n--x--\r\n"
    )


async def request(path, chunks=(), *, headers=(), receive=None, send=None, spec="2.4", method="POST"):
    messages = []
    remaining = iter(chunks)

    async def read():
        try:
            chunk = next(remaining)
        except StopIteration:
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.request", "body": chunk, "more_body": True}

    async def record(message):
        messages.append(message)
        if send:
            await send(message)

    await main.app(
        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": spec},
            "method": method,
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "scheme": "http",
            "server": ("localhost", 8001),
            "client": ("127.0.0.1", 1234),
            "headers": list(headers),
        },
        receive or read,
        record,
    )
    return messages


def response(messages):
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages)
    return start["status"], dict(start["headers"]), json.loads(body)


async def receive_forbidden():
    raise AssertionError("refused request body was read")


async def wait(event):
    if not await asyncio.to_thread(event.wait, 3):
        raise AssertionError("worker did not reach expected phase")


class RequestLimitsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = mock.patch.dict(
            os.environ,
            {
                "SUBSMELT_WHISPER_TOKEN": "",
                "SUBSMELT_WHISPER_TOKEN_FILE": "",
                "SUBSMELT_WHISPER_MAX_ACTIVE_TRANSCRIPTIONS": "1",
                "SUBSMELT_WHISPER_MAX_JSON_BYTES": "1048576",
                "SUBSMELT_WHISPER_BUSY_RETRY_AFTER_SECONDS": "5",
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.gate = mock.patch.object(main, "admission", Admission())
        self.gate.start()
        self.addCleanup(self.gate.stop)

    async def assert_busy(self, route):
        status, headers, body = response(await request(route, receive=receive_forbidden))
        self.assertEqual(status, 503, route)
        self.assertEqual(headers[b"retry-after"], b"5")
        self.assertEqual(body["detail"]["code"], "backend_busy")
        self.assertIn("retry", body["detail"]["message"])

    async def test_invalid_tokens_never_read_protected_json_bodies(self):
        with mock.patch.dict(os.environ, {"SUBSMELT_WHISPER_TOKEN": "secret"}):
            for route in (*JSON_ROUTES, "/models/download/id/cancel", *TRANSCRIBE_ROUTES[2:4]):
                with self.subTest(route=route):
                    status, _, body = response(
                        await request(route, receive=receive_forbidden, headers=((b"authorization", b"Bearer wrong"),))
                    )
                    self.assertEqual((status, body["detail"]["code"]), (401, "unauthorized"))

    async def test_declared_large_json_is_rejected_without_receive(self):
        with mock.patch.dict(os.environ, {"SUBSMELT_WHISPER_MAX_JSON_BYTES": "32"}):
            for route in JSON_ROUTES:
                with self.subTest(route=route):
                    status, _, body = response(
                        await request(route, receive=receive_forbidden, headers=((b"content-length", b"33"),))
                    )
                    self.assertEqual((status, body["detail"]["code"]), (413, "json_too_large"))

    async def test_chunked_and_underdeclared_json_are_capped_on_every_json_route(self):
        with mock.patch.dict(os.environ, {"SUBSMELT_WHISPER_MAX_JSON_BYTES": "32"}):
            for route in JSON_ROUTES:
                for length in ((), ((b"content-length", b"1"),)):
                    with self.subTest(route=route, length=length):
                        status, _, body = response(
                            await request(route, [b'{"padding":"', b"x" * 24, b'"}'], headers=length)
                        )
                        self.assertEqual((status, body["detail"]["code"]), (413, "json_too_large"))

    async def test_valid_token_reaches_json_validation_and_public_version_stays_open(self):
        with mock.patch.dict(os.environ, {"SUBSMELT_WHISPER_TOKEN": "secret"}):
            status, _, _ = response(await request("/preflight", [b"{}"], headers=((b"x-subsmelt-token", b"secret"),)))
            self.assertEqual(status, 422)
            status, _, body = response(await request("/version", method="GET"))
            self.assertEqual(status, 200)
            self.assertIn("version", body)

    async def test_active_shared_request_refuses_every_transport_before_receive(self):
        entered, finish = threading.Event(), threading.Event()

        def block(*args, **kwargs):
            entered.set()
            finish.wait(3)
            return {"ok": True, "content": "subtitle", "segments": 1, "language": "en"}

        with (
            mock.patch.object(main, "USE_FAKE_TRANSCRIBE", False),
            mock.patch.object(main, "validate_transcribe_request", return_value=Path("/media/clip.wav")),
            mock.patch.object(main, "run_transcription", block),
        ):
            active = asyncio.create_task(request("/transcribe", [b'{"input_path":"/media/clip.wav"}']))
            try:
                await wait(entered)
                for route in TRANSCRIBE_ROUTES:
                    await self.assert_busy(route)
                status, _, _ = response(await request("/preflight", [b"{}"]))
                self.assertEqual(status, 422, "preflight must not consume a transcription slot")
            finally:
                finish.set()
                messages = await active
            self.assertEqual(response(messages)[0], 200)
        self.assertEqual(response(await request("/transcribe", [b"{}"]))[0], 422)

    async def test_upload_reserves_before_first_multipart_byte_and_releases_on_disconnect(self):
        entered, disconnect = asyncio.Event(), asyncio.Event()

        async def stalled_upload():
            entered.set()
            await disconnect.wait()
            return {"type": "http.disconnect"}

        active = asyncio.create_task(
            request(
                "/transcribe/upload",
                receive=stalled_upload,
                headers=((b"content-type", b"multipart/form-data; boundary=x"),),
            )
        )
        await asyncio.wait_for(entered.wait(), 3)
        try:
            for route in TRANSCRIBE_ROUTES:
                await self.assert_busy(route)
        finally:
            disconnect.set()
            await active
        self.assertEqual(response(await request("/transcribe", [b"{}"]))[0], 422)

    async def test_cancelled_nonstream_upload_keeps_slot_and_temp_until_worker_finishes(self):
        entered, finish = threading.Event(), threading.Event()
        saved = []

        def block(_parsed, path, **kwargs):
            saved.append(path)
            entered.set()
            finish.wait(3)
            self.assertTrue(path.exists())
            return {"ok": True, "content": "subtitle", "segments": 1, "language": "en"}

        with (
            mock.patch.object(main, "USE_FAKE_TRANSCRIBE", False),
            mock.patch.object(main, "validate_upload_request"),
            mock.patch.object(main, "run_transcription", block),
        ):
            active = asyncio.create_task(
                request(
                    "/transcribe/upload",
                    [multipart()],
                    headers=((b"content-type", b"multipart/form-data; boundary=x"),),
                )
            )
            try:
                await wait(entered)
                active.cancel()
                await asyncio.sleep(0)
                self.assertFalse(active.done())
                await self.assert_busy("/transcribe/stream")
                self.assertTrue(saved[0].exists())
            finally:
                finish.set()
                with self.assertRaises(asyncio.CancelledError):
                    await active
            self.assertFalse(saved[0].parent.exists())
        self.assertEqual(response(await request("/transcribe", [b"{}"]))[0], 422)

    async def test_disconnect_retains_stream_slot_through_generator_and_temp_cleanup(self):
        entered, finish, cleaning, finish_cleanup, cleaned = (threading.Event() for _ in range(5))
        saved = []
        original_response = main._upload_stream_response

        def observe_cleanup(path, parsed, tmp, *args):
            original_cleanup = tmp.cleanup

            def cleanup():
                cleaning.set()
                finish_cleanup.wait(3)
                original_cleanup()
                cleaned.set()

            tmp.cleanup = cleanup
            return original_response(path, parsed, tmp, *args)

        def block(_parsed, path, is_cancelled, **kwargs):
            saved.append(path)
            try:
                yield {"type": "progress", "pct": 1}
                entered.set()
                finish.wait(3)
            finally:
                self.assertTrue(path.exists())

        async def failed_send(message):
            if message["type"] == "http.response.body":
                await wait(entered)
                raise OSError("peer disconnected")

        with (
            mock.patch.object(main, "USE_FAKE_TRANSCRIBE", False),
            mock.patch.object(main, "validate_upload_request"),
            mock.patch.object(main, "run_transcription_streaming", block),
            mock.patch.object(main, "_upload_stream_response", observe_cleanup),
        ):
            try:
                with self.assertRaises(ClientDisconnect):
                    await request(
                        "/transcribe/upload/stream",
                        [multipart()],
                        headers=((b"content-type", b"multipart/form-data; boundary=x"),),
                        send=failed_send,
                    )
                for route in TRANSCRIBE_ROUTES:
                    await self.assert_busy(route)
                finish.set()
                await wait(cleaning)
                await self.assert_busy("/transcribe/upload")
                self.assertTrue(saved[0].exists())
            finally:
                finish.set()
                finish_cleanup.set()
                await wait(cleaned)
        self.assertFalse(saved[0].parent.exists())
        # Worker release follows cleanup; yield once for its final instructions.
        await asyncio.to_thread(lambda: None)
        self.assertEqual(response(await request("/transcribe", [b"{}"]))[0], 422)

    async def test_asgi20_disconnect_keeps_worker_slot_until_generator_closes(self):
        entered, finish, cleaned = threading.Event(), threading.Event(), threading.Event()
        disconnect = asyncio.Event()
        body_sent = False

        def block(*args, **kwargs):
            try:
                yield {"type": "progress", "pct": 1}
                entered.set()
                finish.wait(3)
            finally:
                cleaned.set()

        async def receive():
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {"type": "http.request", "body": b'{"input_path":"/media/clip.wav"}', "more_body": False}
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def leave(message):
            if message["type"] == "http.response.body":
                await wait(entered)
                disconnect.set()

        with (
            mock.patch.object(main, "USE_FAKE_TRANSCRIBE", False),
            mock.patch.object(main, "validate_transcribe_request", return_value=Path("/media/clip.wav")),
            mock.patch.object(main, "run_transcription_streaming", block),
        ):
            try:
                await request("/transcribe/stream", receive=receive, send=leave, spec="2.0")
                await self.assert_busy("/transcribe/upload")
            finally:
                finish.set()
                await wait(cleaned)
        await asyncio.to_thread(lambda: None)
        self.assertEqual(response(await request("/transcribe", [b"{}"]))[0], 422)

    async def test_configurable_active_limit_admits_exactly_two_requests(self):
        entered = [asyncio.Event(), asyncio.Event()]
        finish = asyncio.Event()

        def read(index):
            async def receive():
                entered[index].set()
                await finish.wait()
                return {"type": "http.request", "body": b"{}", "more_body": False}

            return receive

        with mock.patch.dict(os.environ, {"SUBSMELT_WHISPER_MAX_ACTIVE_TRANSCRIPTIONS": "2"}):
            tasks = [
                asyncio.create_task(request(route, receive=read(i))) for i, route in enumerate(TRANSCRIBE_ROUTES[:2])
            ]
            try:
                for event in entered:
                    await asyncio.wait_for(event.wait(), 3)
                await self.assert_busy("/transcribe/url/stream")
            finally:
                finish.set()
                await asyncio.gather(*tasks)

    async def test_partial_multipart_spools_close_before_releasing_admission(self):
        import starlette.formparsers as forms

        original = forms.SpooledTemporaryFile
        opened = []

        def spool(*args, **kwargs):
            file = original(*args, **kwargs)
            opened.append(file)
            return file

        prefix = multipart().split(b"fake audio")[0]
        for ending in ("oversize", "disconnect"):
            with self.subTest(ending=ending):
                chunks = iter([prefix + b"a" * 600000, b"b" * 600000])

                async def receive(chunks=chunks, ending=ending):
                    chunk = next(chunks)
                    if ending == "disconnect" and chunk.startswith(b"b"):
                        return {"type": "http.disconnect"}
                    return {"type": "http.request", "body": chunk, "more_body": True}

                with (
                    mock.patch.object(forms, "SpooledTemporaryFile", spool),
                    mock.patch.dict(os.environ, {"SUBSMELT_WHISPER_MAX_UPLOAD_MB": "1"}),
                ):
                    messages = await request(
                        "/transcribe/upload",
                        receive=receive,
                        headers=((b"content-type", b"multipart/form-data; boundary=x"),),
                    )
                self.assertEqual(response(messages)[0], 413 if ending == "oversize" else 400)
                self.assertTrue(opened)
                self.assertTrue(all(file.closed for file in opened))
                self.assertEqual(response(await request("/transcribe", [b"{}"]))[0], 422)

    async def test_url_download_holds_admission_before_inference(self):
        entered, finish = threading.Event(), threading.Event()

        def download(_url, dest):
            entered.set()
            finish.wait(3)
            path = dest / "audio.wav"
            path.write_bytes(b"audio")
            return path

        with (
            mock.patch.object(main, "USE_FAKE_TRANSCRIBE", True),
            mock.patch.object(main, "validate_upload_request"),
            mock.patch.object(main, "download_url", download),
        ):
            active = asyncio.create_task(request("/transcribe/url/stream", [b'{"url":"https://example.com/audio"}']))
            try:
                await wait(entered)
                for route in TRANSCRIBE_ROUTES:
                    await self.assert_busy(route)
            finally:
                finish.set()
                messages = await active
            self.assertEqual(messages[0]["status"], 200)
        self.assertEqual(response(await request("/transcribe", [b"{}"]))[0], 422)

    async def test_invalid_limits_fail_startup_with_variable_name(self):
        for name in (
            "SUBSMELT_WHISPER_MAX_ACTIVE_TRANSCRIPTIONS",
            "SUBSMELT_WHISPER_MAX_JSON_BYTES",
            "SUBSMELT_WHISPER_BUSY_RETRY_AFTER_SECONDS",
            "SUBSMELT_WHISPER_MAX_UPLOAD_MB",
        ):
            for value in ("0", "-1", "unlimited"):
                with self.subTest(name=name, value=value), mock.patch.dict(os.environ, {name: value}):
                    with self.assertRaisesRegex(ValueError, name):
                        async with main._lifespan(main.app):
                            self.fail("invalid configuration started")


class StreamBufferTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_consumer_bounds_production_and_preserves_terminal_result(self):
        produced = []
        filled = threading.Event()

        def generate():
            for i in range(main.STREAM_BUFFER_EVENTS + 5):
                produced.append(i)
                if len(produced) == main.STREAM_BUFFER_EVENTS + 2:
                    filled.set()
                yield {"type": "progress", "pct": i}
            yield {"type": "result", "content": "terminal subtitle"}

        stream = main._ndjson_stream(generate(), threading.Event())
        first = json.loads(await anext(stream))
        await wait(filled)
        # One item is yielded, the queue holds its finite capacity, and one
        # pending put blocks the producer before it can call next() again.
        self.assertEqual(len(produced), main.STREAM_BUFFER_EVENTS + 2)
        events = [first, *[json.loads(line) async for line in stream]]
        self.assertEqual(events[-1], {"type": "result", "content": "terminal subtitle"})
        self.assertEqual([e["pct"] for e in events[:-1]], list(range(main.STREAM_BUFFER_EVENTS + 5)))

    async def test_full_buffer_disconnect_unblocks_producer_and_closes_generator(self):
        filled, closed, cleaned = threading.Event(), threading.Event(), threading.Event()

        def generate():
            try:
                for i in range(10000):
                    if i == main.STREAM_BUFFER_EVENTS + 1:
                        filled.set()
                    yield {"type": "progress", "pct": i}
            finally:
                closed.set()

        stream = main._ndjson_stream(generate(), threading.Event(), cleanup=cleaned.set)
        await anext(stream)
        await wait(filled)
        await stream.aclose()
        await wait(cleaned)
        self.assertTrue(closed.is_set())

    async def test_response_header_failure_cancels_worker_before_iterator_started(self):
        closed, cleaned = threading.Event(), threading.Event()

        def generate():
            try:
                for i in range(10000):
                    yield {"type": "progress", "pct": i}
            finally:
                closed.set()

        async def fail(_message):
            raise OSError("peer gone before response headers")

        cancel = threading.Event()
        reservation = Admission().acquire(1)
        token = current_reservation.set(reservation)
        try:
            stream = main._ndjson_stream(generate(), cancel, cleanup=cleaned.set)
            reply = main._TranscriptionStreamResponse(stream, cancel)
            with self.assertRaises(ClientDisconnect):
                await reply({"type": "http", "asgi": {"spec_version": "2.4"}}, receive_forbidden, fail)
        finally:
            current_reservation.reset(token)
            reservation.release()
        await wait(cleaned)
        self.assertTrue(closed.is_set())
