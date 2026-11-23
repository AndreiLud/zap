"""Logs: training/logs/cycle.log (rotating at 10 MB, 5 files) and one file per cycle under
training/logs/runs/ with the output of every subprocess (newest 20 kept).

No secret reaches a log: the values of the credential variables are replaced wherever they appear,
and subprocesses never receive them (proc.child_env).
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
from pathlib import Path

SECRET_VARS = (
    "R2_EVENTS_ACCESS_KEY_ID",
    "R2_EVENTS_SECRET_ACCESS_KEY",
    "R2_PUBLISH_ACCESS_KEY_ID",
    "R2_PUBLISH_SECRET_ACCESS_KEY",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "GITHUB_RELEASES_TOKEN",
)
MAX_BYTES = 10 * 1024 * 1024
BACKUPS = 5
KEEP_RUN_LOGS = 20


def redact(text: str, env: dict | None = None) -> str:
    env = os.environ if env is None else env
    for k in SECRET_VARS:
        v = env.get(k, "")
        if len(v) >= 4:
            text = text.replace(v, "***")
    return text


class RedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = ()
        return True


def setup_logging(logs_dir: Path, quiet: bool = False) -> logging.Logger:
    log = logging.getLogger("zapcycle")
    log.setLevel(logging.INFO)
    for h in list(log.handlers):
        log.removeHandler(h)
        h.close()
    log.filters.clear()
    log.addFilter(RedactFilter())
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    logs_dir.mkdir(parents=True, exist_ok=True)
    fh = logging.handlers.RotatingFileHandler(logs_dir / "cycle.log", maxBytes=MAX_BYTES, backupCount=BACKUPS)
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if not quiet:
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        log.addHandler(sh)
    log.propagate = False
    return log


def run_log_path(logs_dir: Path, cycle_id: str) -> Path:
    d = logs_dir / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{cycle_id}.log"


def prune_run_logs(logs_dir: Path, keep: int = KEEP_RUN_LOGS) -> list[Path]:
    d = logs_dir / "runs"
    if not d.is_dir():
        return []
    files = sorted(d.glob("*.log"), key=lambda p: (p.stat().st_mtime, p.name))
    gone = files[: max(0, len(files) - keep)]
    for p in gone:
        p.unlink(missing_ok=True)
    return gone
