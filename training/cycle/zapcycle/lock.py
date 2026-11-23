"""File locks with fcntl.flock: the cycle lock (a whole cycle) and the manifest lock (short).

The kernel releases a flock when its holder dies, so a stale file never blocks a later cycle; the
JSON inside only tells who holds it.
"""

from __future__ import annotations

import fcntl
import json
import os
import time
from pathlib import Path

from .errors import LockBusy


class FileLock:
    def __init__(self, path: Path, info: dict | None = None, wait_s: float = 0.0, poll_s: float = 0.2):
        self.path = Path(path)
        self.info = info or {}
        self.wait_s = wait_s
        self.poll_s = poll_s
        self._fh = None

    def acquire(self) -> "FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.path, "a+")
        deadline = time.monotonic() + self.wait_s
        while True:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    fh.seek(0)
                    holder = fh.read().strip()
                    fh.close()
                    raise LockBusy(f"lock busy: {self.path.name}" + (f" held by {holder}" if holder else ""))
                time.sleep(self.poll_s)
        fh.seek(0)
        fh.truncate()
        fh.write(json.dumps({"pid": os.getpid(), **self.info}))
        fh.flush()
        self._fh = fh
        return self

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            self._fh.seek(0)
            self._fh.truncate()
            self._fh.flush()
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        finally:
            self._fh.close()
            self._fh = None

    def __enter__(self) -> "FileLock":
        return self.acquire()

    def __exit__(self, *exc) -> None:
        self.release()


def lock_holder(path: Path) -> dict | None:
    """None when nobody holds the lock; otherwise what the holder wrote ({} when unreadable)."""
    path = Path(path)
    if not path.exists():
        return None
    with open(path, "a+") as fh:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fh.seek(0)
            try:
                return json.loads(fh.read() or "{}")
            except json.JSONDecodeError:
                return {}
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        return None


def cycle_lock(data_dir: Path, cycle_id: str | None, started_at: int) -> FileLock:
    return FileLock(Path(data_dir) / "locks" / "cycle.lock", {"cycleId": cycle_id, "startedAt": started_at})


def manifest_lock(data_dir: Path) -> FileLock:
    """Held only while reading and writing manifest.json; waits up to 2 minutes for another holder."""
    return FileLock(Path(data_dir) / "locks" / "manifest.lock", {}, wait_s=120.0)
