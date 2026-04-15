"""
Small SQLite-backed task store.

Tasks represent either a transcription run (``kind='transcribe'``) or a model
download (``kind='download'``). A single table is used for both so the subsmelt
frontend and this backend share one progress / polling path.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterator, Optional

_DB_LOCK = threading.Lock()
_DB: Optional["TaskStore"] = None


@dataclass
class Task:
    id: str
    kind: str                       # 'transcribe' | 'download'
    status: str                     # 'queued' | 'running' | 'done' | 'error' | 'cancelled'
    stage: Optional[str] = None     # extracting|uvr|vad|transcribing|writing|downloading
    progress: float = 0.0           # 0..1
    error: Optional[str] = None
    video_path: Optional[str] = None
    output_path: Optional[str] = None
    output_format: Optional[str] = None
    model_kind: Optional[str] = None
    model_name: Optional[str] = None
    options_json: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        # cancel_requested is internal state; not exposed.
        return d


class TaskStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._cancel_flags: dict[str, bool] = {}
        self._init_schema()
        # On startup, mark any "running" rows as errored — the worker died mid-flight.
        with self._lock:
            self._conn.execute(
                "UPDATE tasks SET status='error', error='Interrupted by restart', "
                "updated_at=? WHERE status IN ('running', 'queued')",
                (time.time(),),
            )
            self._conn.commit()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    stage TEXT,
                    progress REAL DEFAULT 0,
                    error TEXT,
                    video_path TEXT,
                    output_path TEXT,
                    output_format TEXT,
                    model_kind TEXT,
                    model_name TEXT,
                    options_json TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            self._conn.commit()

    # --- CRUD ---------------------------------------------------------------

    def create(self, task: Task) -> Task:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO tasks (id, kind, status, stage, progress, error,
                                   video_path, output_path, output_format,
                                   model_kind, model_name, options_json,
                                   created_at, updated_at)
                VALUES (:id, :kind, :status, :stage, :progress, :error,
                        :video_path, :output_path, :output_format,
                        :model_kind, :model_name, :options_json,
                        :created_at, :updated_at)
                """,
                asdict(task),
            )
            self._conn.commit()
        return task

    def get(self, task_id: str) -> Optional[Task]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
        return _row_to_task(row) if row else None

    def list(self, kind: Optional[str] = None, limit: int = 200) -> list[Task]:
        q = "SELECT * FROM tasks"
        args: tuple[Any, ...] = ()
        if kind:
            q += " WHERE kind = ?"
            args = (kind,)
        q += " ORDER BY created_at DESC LIMIT ?"
        args = (*args, limit)
        with self._lock:
            rows = self._conn.execute(q, args).fetchall()
        return [_row_to_task(r) for r in rows]

    def update(self, task_id: str, **fields: Any) -> Optional[Task]:
        if not fields:
            return self.get(task_id)
        fields["updated_at"] = time.time()
        keys = ", ".join(f"{k} = :{k}" for k in fields)
        params = {**fields, "id": task_id}
        with self._lock:
            self._conn.execute(
                f"UPDATE tasks SET {keys} WHERE id = :id", params
            )
            self._conn.commit()
        return self.get(task_id)

    def delete(self, task_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            self._conn.commit()
            self._cancel_flags.pop(task_id, None)

    # --- cancel plumbing ----------------------------------------------------

    def request_cancel(self, task_id: str) -> None:
        with self._lock:
            self._cancel_flags[task_id] = True

    def is_cancel_requested(self, task_id: str) -> bool:
        with self._lock:
            return bool(self._cancel_flags.get(task_id))

    def clear_cancel(self, task_id: str) -> None:
        with self._lock:
            self._cancel_flags.pop(task_id, None)


def _row_to_task(row: sqlite3.Row) -> Task:
    return Task(
        id=row["id"],
        kind=row["kind"],
        status=row["status"],
        stage=row["stage"],
        progress=row["progress"] or 0.0,
        error=row["error"],
        video_path=row["video_path"],
        output_path=row["output_path"],
        output_format=row["output_format"],
        model_kind=row["model_kind"],
        model_name=row["model_name"],
        options_json=row["options_json"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def new_task_id() -> str:
    return uuid.uuid4().hex


def get_store(config_dir: Path) -> TaskStore:
    global _DB
    with _DB_LOCK:
        if _DB is None:
            _DB = TaskStore(config_dir / "tasks.db")
        return _DB


def options_to_json(options: dict[str, Any]) -> str:
    return json.dumps(options, default=str)
