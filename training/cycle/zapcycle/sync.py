"""sync (contract 3.6): new match records, the newest daily export and recent receipts, from the
events bucket into data/<profile>/."""

from __future__ import annotations

import json
import os
import re
from datetime import date, timedelta
from pathlib import Path

from . import formats
from .core import Cycle, sha256_bytes, utc_date
from .errors import CycleError, FormatError
from .index import Index
from .storage import TooLarge

MAX_RECORD = formats.SIZE_LIMITS["zap-match"]
EXPORT_KEY = re.compile(r"^exports/(\d{4}-\d{2}-\d{2})\.json$")
RECEIPT_KEY = re.compile(r"^receipts/(\d{4}-\d{2}-\d{2})\.json$")
RECEIPT_DAYS = 8


def day_prefixes(cursor: str | None, today: str) -> list[str]:
    """matches/v1/YYYY/MM/DD/ for each UTC day from cursorDate - 1 to today; the whole layout without a cursor."""
    if cursor is None:
        return ["matches/v1/"]
    d = date.fromisoformat(cursor) - timedelta(days=1)
    end = date.fromisoformat(today)
    out = []
    while d <= end:
        out.append(f"matches/v1/{d:%Y/%m/%d}/")
        d += timedelta(days=1)
    return out


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def record_mark(body: bytes) -> tuple[int | None, bool]:
    """endedAt and the test mark of a record (zap-match/1 has no mark: false)."""
    r = json.loads(body)
    if not isinstance(r, dict):
        raise ValueError("not an object")
    test = r.get("test", False) if r.get("schema") == "zap-match/2" else False
    ended = r.get("endedAt")
    return (ended if isinstance(ended, int) else None), test is True


def sync(cyc: Cycle) -> dict:
    cfg = cyc.cfg
    events = cyc.events
    now = cyc.clock()
    today = utc_date(now)
    data = cfg.data_dir
    records_dir = data / "records"
    index = Index(data / "index.sqlite")
    out = {"listed": 0, "downloaded": 0, "unchanged": 0, "tooLarge": 0, "invalid": 0, "notTest": 0, "export": None, "receipts": 0}
    try:
        for prefix in day_prefixes(cyc.state.get("cursorDate"), today):
            for o in events.list(prefix):
                if not o.key.endswith(".json"):
                    continue
                out["listed"] += 1
                if index.etag(o.key) == o.etag:
                    out["unchanged"] += 1
                    continue
                if o.size > MAX_RECORD:
                    index.put(o.key, o.etag, o.size, None, None, False, "over 256 KB")
                    out["tooLarge"] += 1
                    continue
                try:
                    obj = events.get(o.key, MAX_RECORD)
                except TooLarge:
                    index.put(o.key, o.etag, o.size, None, None, False, "over 256 KB")
                    out["tooLarge"] += 1
                    continue
                if obj is None:
                    continue
                try:
                    ended, test = record_mark(obj.body)
                except (ValueError, UnicodeDecodeError):
                    index.put(o.key, obj.etag, obj.size, None, None, False, "not JSON")
                    out["invalid"] += 1
                    continue
                if cfg.mode == "r2" and test:
                    raise CycleError(f"test record in production: {o.key}")
                valid = None
                error = None
                if cfg.mode == "minio" and not test:
                    valid, error = False, "not a test record"
                    out["notTest"] += 1
                _write(records_dir / o.key, obj.body)
                index.put(o.key, obj.etag, obj.size, ended, test, valid, error)
                out["downloaded"] += 1
            index.commit()
    finally:
        index.close()

    out["export"] = _sync_export(cyc, today)
    out["receipts"] = _sync_receipts(cyc, today)
    cyc.state["cursorDate"] = today
    cyc.state.save()
    return out


def _sync_export(cyc: Cycle, today: str) -> dict | None:
    """The newest complete export up to today becomes exports/latest.json; older local ones go away."""
    events = cyc.events
    exports_dir = cyc.cfg.data_dir / "exports"
    found = sorted(((m.group(1), o) for o in events.list("exports/") if (m := EXPORT_KEY.match(o.key)) and m.group(1) <= today), key=lambda x: x[0], reverse=True)
    for day, o in found:
        prev = cyc.state.get("latestExport")
        if prev and prev.get("key") == o.key and prev.get("etag") == o.etag and (exports_dir / "latest.json").exists():
            return prev
        try:
            obj = events.get(o.key, formats.SIZE_LIMITS["zap-export/1"])
            if obj is None:
                continue
            ex = formats.load("zap-export/1", obj.body)
        except (FormatError, TooLarge) as e:
            cyc.log.warning(f"export {o.key} refused: {e}")
            continue
        if ex["partial"]:
            cyc.log.info(f"export {o.key} is partial; looking for an older one")
            continue
        _write(exports_dir / "latest.json", obj.body)
        for p in exports_dir.glob("*.json"):
            if p.name != "latest.json":
                p.unlink()
        info = {"date": ex["date"], "sha256": sha256_bytes(obj.body), "key": o.key, "etag": obj.etag}
        cyc.state["latestExport"] = info
        return info
    return cyc.state.get("latestExport")


def _sync_receipts(cyc: Cycle, today: str) -> int:
    events = cyc.events
    d = cyc.cfg.data_dir / "receipts"
    since = (date.fromisoformat(today) - timedelta(days=RECEIPT_DAYS - 1)).isoformat()
    n = 0
    for o in events.list("receipts/"):
        m = RECEIPT_KEY.match(o.key)
        if not m or not since <= m.group(1) <= today:
            continue
        local = d / f"{m.group(1)}.json"
        if local.exists() and cyc.state.get("receiptEtags", {}).get(o.key) == o.etag:
            continue
        try:
            obj = events.get(o.key, formats.SIZE_LIMITS["zap-receipt/1"])
            if obj is None:
                continue
            formats.load("zap-receipt/1", obj.body)
        except (FormatError, TooLarge) as e:
            cyc.log.warning(f"receipt {o.key} refused: {e}")
            continue
        _write(local, obj.body)
        cyc.state.setdefault("receiptEtags", {})[o.key] = obj.etag
        n += 1
    for p in d.glob("*.json") if d.is_dir() else []:
        if p.stem < since:
            p.unlink()
            cyc.state.get("receiptEtags", {}).pop(f"receipts/{p.name}", None)
    return n
