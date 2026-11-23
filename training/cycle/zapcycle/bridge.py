"""Python half of the local bridge (contract 4.2), minio mode only.

push: .cache/bridge/<state>/events/ (written by bridge.ts export from the local Worker's R2 files)
      into the profile's events bucket, keys mirrored, unchanged files skipped.
pull: every object of the profile's models bucket into .cache/bridge/<state>/models/ (read by
      bridge.ts import into the local Worker's zap-models).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .config import ROOT
from .core import Cycle
from .errors import GuardError
from .storage import JSON_TYPE, MODEL_TYPE

STATES = ("dev", "e2e", "fixtures")
PREFIXES = ("matches/", "exports/", "receipts/")


def bridge_dir(state: str) -> Path:
    if state not in STATES:
        raise GuardError(f"--state must be one of {', '.join(STATES)}")
    return ROOT / ".cache" / "bridge" / state


def _check(cyc: Cycle) -> None:
    if cyc.cfg.mode != "minio":
        raise GuardError("the bridge works only in minio mode")


def push(cyc: Cycle, state: str) -> dict:
    _check(cyc)
    src = bridge_dir(state) / "events"
    store = cyc.store("bridge")
    sent = skipped = 0
    remote = {}
    for prefix in PREFIXES:
        for o in store.list("events", prefix):
            remote[o.key] = o.etag
    for p in sorted(src.rglob("*")) if src.is_dir() else []:
        if not p.is_file():
            continue
        key = p.relative_to(src).as_posix()
        if not key.startswith(PREFIXES):
            continue
        body = p.read_bytes()
        if remote.get(key) == hashlib.md5(body).hexdigest():
            skipped += 1
            continue
        store.put("events", key, body, JSON_TYPE if key.endswith(".json") else MODEL_TYPE)
        sent += 1
    return {"state": state, "sent": sent, "unchanged": skipped}


def pull(cyc: Cycle, state: str) -> dict:
    _check(cyc)
    dst = bridge_dir(state) / "models"
    store = cyc.store("bridge")
    n = 0
    for o in store.list("models", ""):
        if ".." in o.key.split("/") or o.key.startswith("/"):
            raise GuardError(f"unsafe key {o.key}")
        obj = store.get("models", o.key)
        if obj is None:
            continue
        f = dst / o.key
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(obj.body)
        n += 1
    (dst / ".pulled.json").write_text(json.dumps({"objects": n}) + "\n")
    return {"state": state, "pulled": n}
