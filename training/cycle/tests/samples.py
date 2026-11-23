"""Valid sample objects of the cycle's formats, built the way the cycle builds them."""

from __future__ import annotations

import copy
import json
import shutil
from pathlib import Path

from zapcycle.card import bootstrap_card
from zapcycle.config import ROOT
from zapcycle.core import sha256_file, write_json

SEGS = ("paulista-2", "paulista-4", "mineiro-2", "mineiro-4")
BUNDLED = json.loads((ROOT / "ai/models/bootstrap/manifest.json").read_text())


def gate_result(candidate: str, cand_sha: str, current: str, cur_sha: str, passed: bool) -> dict:
    iv = {"mean": 0.6, "lo": 0.55, "hi": 0.65}
    return {
        "schema": "zap-gate/1",
        "candidate": {"version": candidate, "sha256": cand_sha},
        "current": {"version": current, "sha256": cur_sha},
        "seed": "ab" * 32,
        "stats": "empty",
        "sprt": {"decision": "accept" if passed else "reject", "llr": 3.1 if passed else -3.0, "lower": -2.944, "upper": 2.944, "pairs": 400, "mean": 0.56 if passed else 0.5, "perSegment": {s: {"pairs": 100, "mean": 0.56} for s in SEGS}},
        "segments": {s: {"pairs": 2500, "mean": 0.55, "lo95": 0.02, "pass": True} for s in SEGS},
        "panel": [{"member": m, "pairs": 4000, "candidate": dict(iv), "current": dict(iv), "diff": {"mean": 0.0, "lo95": -0.005}, "pass": True} for m in ("random", "base", "tuned", "v1")],
        "personas": {"orderHolds": True, "source": "work/gate/personas.json"},
        "pass": passed,
        "reasons": [] if passed else ["The sequential test stopped for no gain after 400 pairs."],
        "seconds": 12.5,
    }


def manifest_v1(now: int = 1_763_800_000_000) -> dict:
    card = bootstrap_card(BUNDLED, now)
    return {"schema": "zap-manifest/1", "current": "v1", "control": None, "controlShare": 0.3, "controlUntil": None, "updatedAt": now, "models": {"v1": {**card["model"], "personas": BUNDLED["personas"], "createdAt": card["createdAt"]}}}


def status(state: str = "ok") -> dict:
    return {"schema": "zap-status/1", "state": state, "startedAt": None, "finishedAt": None, "updatedAt": 1_763_800_000_000, "cycleId": None, "step": "idle", "lastPromotion": None, "message": "ok"}


def make_candidate(cyc, cycle_id: str, version: str, parent: str, passed: bool) -> Path:
    """A work folder as train and gate leave it, with a model file that differs from v1."""
    work = cyc.work(cycle_id)
    exp = work / "export"
    exp.mkdir(parents=True, exist_ok=True)
    f = exp / f"zap-{version}.zapw"
    f.write_bytes((ROOT / "ai/models/bootstrap/zap-v1.zapw").read_bytes() + version.encode())
    man = {"version": version, "file": f.name, "bytes": f.stat().st_size, "sha256": sha256_file(f), "arch": "mlp-v1", "features": "v1", "inputs": 431, "hidden": [256, 256], "adapt": None, "createdAt": "2026-11-21T12:00:00.000Z", "source": "x", "note": "", "personas": copy.deepcopy(BUNDLED["personas"])}
    write_json(exp / "manifest.json", man)
    snap = work / "runs" / "candidate" / "league" / "it000002.zapw"
    snap.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(f, snap)
    train = {
        "cycleId": cycle_id, "version": version, "parent": parent, "initFrom": "x", "snapshot": str(snap), "checkpoint": None, "argsFile": None,
        "export": {"file": str(f), "manifest": man},
        "training": {"args": ["--iters", "2"], "iterations": 2, "seconds": 10.0, "seedBase": "5a", "leagueFiles": [], "humanModel": None, "commit": None},
        "setups": {}, "twin": None,
    }
    write_json(work / "train.json", train)
    cur = cyc.require_manifest()
    write_json(work / "gate" / "result.json", gate_result(version, man["sha256"], cur["current"], cur["models"][cur["current"]]["sha256"], passed))
    write_json(work / "gate" / "personas.json", {"knobs": man["personas"], "order": {"otavioEasiest": True, "iaraHardestAfterZap": True}, "stats": {"zap": {"trucoRate": 0.3, "bluffRate": 0.1, "runRate": 0.2, "reraiseRate": 0.05, "signalTruth": 0.9, "vsZap": 0.5}}})
    return work
