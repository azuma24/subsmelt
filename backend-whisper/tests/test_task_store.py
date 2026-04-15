"""Tests for the SQLite TaskStore."""

from pathlib import Path

import pytest

from subsmelt_whisper.state.db import Task, TaskStore, new_task_id


@pytest.fixture
def store(tmp_path: Path) -> TaskStore:
    return TaskStore(tmp_path / "tasks.db")


def _mk(kind: str = "transcribe") -> Task:
    return Task(id=new_task_id(), kind=kind, status="queued")


def test_create_and_get(store: TaskStore):
    t = _mk()
    store.create(t)
    got = store.get(t.id)
    assert got is not None
    assert got.id == t.id
    assert got.status == "queued"


def test_update_transitions(store: TaskStore):
    t = _mk()
    store.create(t)
    store.update(t.id, status="running", stage="extracting", progress=0.1)
    got = store.get(t.id)
    assert got.status == "running"
    assert got.stage == "extracting"
    assert got.progress == pytest.approx(0.1)


def test_cancel_flag(store: TaskStore):
    t = _mk()
    store.create(t)
    assert not store.is_cancel_requested(t.id)
    store.request_cancel(t.id)
    assert store.is_cancel_requested(t.id)
    store.clear_cancel(t.id)
    assert not store.is_cancel_requested(t.id)


def test_list_filters_by_kind(store: TaskStore):
    a = _mk("transcribe")
    b = _mk("download")
    store.create(a)
    store.create(b)
    assert {t.id for t in store.list(kind="transcribe")} == {a.id}
    assert {t.id for t in store.list(kind="download")} == {b.id}


def test_restart_marks_running_as_error(tmp_path: Path):
    path = tmp_path / "tasks.db"
    s1 = TaskStore(path)
    t = _mk()
    s1.create(t)
    s1.update(t.id, status="running")
    # Re-open: simulate restart.
    s2 = TaskStore(path)
    got = s2.get(t.id)
    assert got.status == "error"
    assert "restart" in (got.error or "").lower()
