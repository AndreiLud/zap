"""Subprocesses of a cycle (Node tools, training/train.py): output into the cycle's run log,
no credentials in their environment, a deadline, and a heartbeat while they run."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

from .config import ROOT
from .errors import CycleError
from .logs import SECRET_VARS, redact

SECRET_PREFIXES = ("R2_", "MINIO_ROOT_", "GITHUB_", "AWS_")


def child_env(extra: dict | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in SECRET_VARS and not k.startswith(SECRET_PREFIXES)}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(extra or {})
    return env


def run(
    cmd: list[str],
    log_path: Path,
    env: dict | None = None,
    deadline: float | None = None,
    heartbeat: Callable[[], None] | None = None,
    heartbeat_every: float = 1800.0,
    cwd: Path = ROOT,
) -> str:
    """Runs cmd and returns its stdout. stdout and stderr also go to log_path. deadline: time.time()
    after which the process group is killed and a CycleError('time limit') raised."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a") as lf:
        lf.write(f"$ {redact(' '.join(cmd))}\n")
        lf.flush()
        proc = subprocess.Popen(cmd, cwd=cwd, env=child_env(env), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        out: list[str] = []
        lock = threading.Lock()

        def pump(stream, keep: bool) -> None:
            for line in stream:
                with lock:
                    lf.write(redact(line))
                    lf.flush()
                if keep:
                    out.append(line)

        threads = [threading.Thread(target=pump, args=(proc.stdout, True), daemon=True), threading.Thread(target=pump, args=(proc.stderr, False), daemon=True)]
        for t in threads:
            t.start()
        last_beat = time.time()
        killed = False
        while True:
            try:
                proc.wait(timeout=1.0)
                break
            except subprocess.TimeoutExpired:
                pass
            now = time.time()
            if deadline is not None and now > deadline:
                kill_group(proc)
                killed = True
                break
            if heartbeat and now - last_beat >= heartbeat_every:
                last_beat = now
                try:
                    heartbeat()
                except Exception as e:  # a failed heartbeat must not stop the work
                    with lock:
                        lf.write(f"heartbeat failed: {redact(str(e))}\n")
        for t in threads:
            t.join(timeout=10)
        for stream in (proc.stdout, proc.stderr):
            if stream:
                stream.close()
        if killed:
            raise CycleError(f"time limit: {Path(cmd[1]).name if len(cmd) > 1 else cmd[0]} stopped at the deadline")
        if proc.returncode != 0:
            raise CycleError(f"{' '.join(Path(c).name if i < 2 else c for i, c in enumerate(cmd[:2]))} failed with exit code {proc.returncode} (see {log_path.name})")
        return "".join(out)


def kill_group(proc: subprocess.Popen, grace: float = 10.0) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()


def last_json_line(stdout: str) -> dict:
    import json

    for line in reversed(stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise CycleError("no JSON result in the tool output")
