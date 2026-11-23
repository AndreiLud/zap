"""data/<profile>/index.sqlite: one row per record key seen by sync (key, etag, size, endedAt, test,
valid, error). valid is null until build has checked the record."""

from __future__ import annotations

import sqlite3
from pathlib import Path


class Index:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL, "
            "endedAt INTEGER, test INTEGER, valid INTEGER, error TEXT)"
        )
        self.db.commit()

    def etag(self, key: str) -> str | None:
        r = self.db.execute("SELECT etag FROM records WHERE key = ?", (key,)).fetchone()
        return r[0] if r else None

    def put(self, key: str, etag: str, size: int, ended_at: int | None, test: bool | None, valid: bool | None, error: str | None) -> None:
        self.db.execute(
            "INSERT INTO records (key, etag, size, endedAt, test, valid, error) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (key) DO UPDATE SET etag = excluded.etag, size = excluded.size, endedAt = excluded.endedAt, "
            "test = excluded.test, valid = excluded.valid, error = excluded.error",
            (key, etag, size, ended_at, None if test is None else int(test), None if valid is None else int(valid), error),
        )

    def mark(self, key: str, valid: bool, error: str | None) -> None:
        self.db.execute("UPDATE records SET valid = ?, error = ? WHERE key = ?", (int(valid), error, key))

    def etags(self) -> dict[str, str]:
        return dict(self.db.execute("SELECT key, etag FROM records"))

    def keys(self) -> set[str]:
        return {r[0] for r in self.db.execute("SELECT key FROM records")}

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM records").fetchone()[0]

    def commit(self) -> None:
        self.db.commit()

    def close(self) -> None:
        self.db.commit()
        self.db.close()
