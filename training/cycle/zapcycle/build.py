"""build (contract 3.6): the decision tables of a cycle, made by node/build.ts from the mirrored
records and the latest export; then the index flags and the data block of the model card."""

from __future__ import annotations

import json
from pathlib import Path

from . import proc
from .core import Cycle, read_json, sha256_bytes, write_json
from .index import Index

BUILD_TS = "training/cycle/node/build.ts"


def run_build(cyc: Cycle, tables: Path, log_path: Path, decisions: bool = True) -> dict:
    data = cyc.cfg.data_dir
    tables.mkdir(parents=True, exist_ok=True)
    cmd = ["node", BUILD_TS, "--records", str(data / "records"), "--out", str(tables), "--config", json.dumps({"mode": cyc.cfg.mode, "deviceCap": cyc.cfg.data["device_cap"]})]
    latest = data / "exports" / "latest.json"
    if latest.exists():
        cmd += ["--export", str(latest)]
    if not decisions:
        cmd.append("--no-decisions")
    summary = proc.last_json_line(proc.run(cmd, log_path))
    card_data = finish(cyc, tables, summary)
    write_json(tables / "data.json", card_data)
    return summary


def finish(cyc: Cycle, tables: Path, summary: dict) -> dict:
    """Marks the index from the build's verdicts and returns the card's data block."""
    index = Index(cyc.cfg.data_dir / "index.sqlite")
    try:
        etags = index.etags()
        used = []
        for line in (tables / "records.jsonl").read_text().splitlines():
            if line:
                key = json.loads(line)["key"]
                used.append(key)
                if key in etags:
                    index.mark(key, True, None)
        inv = tables / "invalid.jsonl"
        for line in inv.read_text().splitlines() if inv.exists() else []:
            if line:
                d = json.loads(line)
                if d["key"] in etags:
                    index.mark(d["key"], False, d["error"][:200])
    finally:
        index.close()
    lines = "".join(f"{k} {etags.get(k, '')}\n" for k in sorted(used))
    ex = cyc.state.get("latestExport") or {}
    return {
        "records": summary["records"],
        "valid": summary["valid"],
        "invalid": summary["invalid"],
        "test": summary["test"],
        "validMatches": summary["validMatches"],
        "linkedSeats": summary["linkedSeats"],
        "people": summary["people"],
        "recordsSha256": sha256_bytes(lines.encode()),
        "exportDate": ex.get("date"),
        "exportSha256": ex.get("sha256"),
        "excluded": {k: summary["excluded"][k] for k in ("unlinked", "flagged", "friends", "auto", "forced", "capped")},
    }


def card_data(tables: Path) -> dict | None:
    p = tables / "data.json"
    return read_json(p) if p.exists() else None
