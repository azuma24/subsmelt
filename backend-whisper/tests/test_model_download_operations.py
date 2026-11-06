from __future__ import annotations

import os
import time
from pathlib import Path
from unittest import mock

import httpx
import pytest
from model_download_fixtures import retryable_download_worker, stalled_download_worker

from app import model_manager as mm


def wait_for_terminal(operation):
    deadline = time.monotonic() + 6
    while operation.snapshot()["status"] in ("running", "cancelling") and time.monotonic() < deadline:
        time.sleep(0.02)
    return operation.snapshot()


def test_download_survives_detached_subscriber_then_cancels_and_preserves_cache(tmp_path):
    env = {"HF_HOME": str(tmp_path)}
    with mock.patch.object(mm, "_download_worker", stalled_download_worker):
        subscriber = mm.download_model_events("tiny", env)
        assert next(subscriber)["pct"] == 20.0
        subscriber.close()
        original = mm.start_model_download("tiny", env)
        reattached = mm.start_model_download("  TINY ", env)
        assert reattached is original
        assert mm.find_model_download(original.id)["progress"]["pct"] == 20.0
        assert next(row for row in mm.describe_models(env) if row["id"] == "tiny")["download"]["id"] == original.id

        with pytest.raises(mm.ModelDownloadInProgressError):
            mm.delete_model("tiny", env)
        assert mm.cancel_model_download(original.id)["status"] == "cancelling"
        assert wait_for_terminal(original)["status"] == "cancelled"
        assert mm.cancel_model_download(original.id)["status"] == "cancelled"
        assert original.terminal["code"] == "model_download_cancelled"
        assert (tmp_path / "model.bin.incomplete").read_bytes() == b"resumable bytes"
        if os.name != "nt":
            with pytest.raises(ProcessLookupError):
                os.kill(int((tmp_path / "worker.pid").read_text()), 0)

    with mock.patch.object(mm, "_download_worker", retryable_download_worker):
        retry = mm.start_model_download("tiny", env)
        assert retry.id != original.id
        assert wait_for_terminal(retry)["status"] == "succeeded"
        assert Path(retry.terminal["cachePath"], "model.bin").read_bytes() == b"resumable bytes"


def test_hard_inactivity_deadline_terminates_worker(tmp_path):
    with (
        mock.patch.object(mm, "_download_worker", stalled_download_worker),
        mock.patch.object(mm, "_DOWNLOAD_STALL_TIMEOUT_S", 1.5),
        mock.patch.object(mm, "_DOWNLOAD_RETRY_DELAYS_S", ()),
    ):
        operation = mm.start_model_download("tiny", {"HF_HOME": str(tmp_path)})
        result = wait_for_terminal(operation)
    assert result["status"] == "failed"
    assert "stalled" in result["error"]
    assert result["progress"]["pct"] == 20.0
    if os.name != "nt":
        with pytest.raises(ProcessLookupError):
            os.kill(int((tmp_path / "worker.pid").read_text()), 0)


def test_transient_failure_retries_using_existing_partial_cache(tmp_path):
    with (
        mock.patch.object(mm, "_download_worker", retryable_download_worker),
        mock.patch.object(mm, "_DOWNLOAD_RETRY_DELAYS_S", (0,)),
    ):
        operation = mm.start_model_download("tiny", {"HF_HOME": str(tmp_path)})
        result = wait_for_terminal(operation)
    assert result["status"] == "succeeded"
    assert Path(operation.terminal["cachePath"], "model.bin").read_bytes() == b"resumable bytes"


@pytest.mark.parametrize("status", [401, 403, 404, 408, 429, 503])
def test_retry_classification_rejects_permanent_http_errors(status):
    request = httpx.Request("GET", "https://example.test")
    response = httpx.Response(status, request=request)
    error = httpx.HTTPStatusError("network request failed", request=request, response=response)
    assert mm._is_transient_download_error(error) == (status in (408, 429, 503))
