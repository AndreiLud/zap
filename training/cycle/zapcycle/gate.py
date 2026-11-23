"""gate (contract 3.8): the spec for gate/gate.ts, the run, the twin comparisons and --force."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path

from . import formats, proc
from .core import BUNDLED_MODEL, Cycle, read_json, rel, sha256_file, write_json
from .errors import CycleError, GuardError

GATE_TS = "training/cycle/gate/gate.ts"
COMPARE_TS = "training/cycle/gate/compare.ts"
ORDER_TS = "training/cycle/gate/personas-order.ts"
FIXED_MEMBERS = [
    {"member": "random", "agent": {"kind": "random"}},
    {"member": "base", "agent": {"kind": "heuristic", "params": "base"}},
    {"member": "tuned", "agent": {"kind": "heuristic", "params": "tuned"}},
    {"member": "v1", "agent": {"kind": "net", "model": BUNDLED_MODEL, "knobs": "zap"}},
]


def cycle_seed(cycle_id: str) -> str:
    return hashlib.sha256(cycle_id.encode()).hexdigest()


def panel(cyc: Cycle, manifest: dict) -> list[dict]:
    """random, base, tuned, v1 and the last panel_versions promoted versions, without duplicates."""
    out = [dict(m) for m in FIXED_MEMBERS]
    recent = [v for v in cyc.promoted() if v != "v1" and v in manifest["models"]][-int(cyc.cfg.gate["panel_versions"]) :]
    for v in recent:
        d = cyc.ensure_version(v, manifest["models"][v])
        out.append({"member": v, "agent": {"kind": "net", "model": rel(d / "model.zapw"), "knobs": "zap"}})
    return out


def spec(cyc: Cycle, cycle_id: str, candidate: dict, current: dict, personas_file: Path, manifest: dict) -> dict:
    g = cyc.cfg.gate
    return {
        "candidate": candidate,
        "current": current,
        "panel": panel(cyc, manifest),
        "seed": cycle_seed(cycle_id),
        "threads": int(g["threads"]),
        "stats": g["stats"],
        "sprt": {"p0": g["p0"], "p1": g["p1"], "alpha": g["alpha"], "beta": g["beta"], "batchPairs": int(g["batch_pairs"]), "capPairs": int(g["cap_pairs"])},
        "segments": {"pairs": int(g["segment_pairs"]), "margin": g["segment_margin"]},
        "panelTest": {"pairs": int(g["panel_pairs"]), "margin": g["panel_margin"]},
        "personas": {"file": rel(personas_file)},
    }


def run_gate(cyc: Cycle, cycle_id: str, log_path: Path, candidate_dir: Path | None = None, force: str | None = None, heartbeat=None) -> dict:
    if force is not None and cyc.cfg.mode != "minio":
        raise GuardError("--force works only in minio mode")
    work = cyc.work(cycle_id)
    train = read_json(work / "train.json")
    exp_dir = Path(candidate_dir) if candidate_dir else work / "export"
    man = read_json(exp_dir / "manifest.json")
    cand_file = exp_dir / man["file"]
    if sha256_file(cand_file) != man["sha256"]:
        raise CycleError("the candidate file does not match its export manifest")
    manifest = cyc.require_manifest()
    cur_v = manifest["current"]
    cur_dir = cyc.ensure_version(cur_v, manifest["models"][cur_v])
    order = personas_order(cyc, cycle_id, cand_file, work / "gate" / "personas.json", log_path, heartbeat)
    s = spec(
        cyc,
        cycle_id,
        {"version": man["version"], "file": rel(cand_file), "sha256": man["sha256"]},
        {"version": cur_v, "file": rel(cur_dir / "model.zapw"), "sha256": manifest["models"][cur_v]["sha256"]},
        order,
        manifest,
    )
    write_json(work / "gate" / "spec.json", s)
    out = work / "gate" / "result.json"
    proc.run(["node", GATE_TS, "--spec", str(work / "gate" / "spec.json"), "--out", str(out)], log_path, env={"ZAP_FACTS": str(work / "facts-scratch.json")}, heartbeat=heartbeat)
    result = read_json(out)
    if result["candidate"]["version"] != man["version"] or result["current"]["version"] != cur_v:
        raise CycleError("the gate result names other versions")
    formats.check("zap-gate/1", result)
    forced = work / "gate" / "forced.json"
    if force is not None:
        # The measured result stays as it is; publish reads the override from its own file.
        write_json(forced, {"force": force, "measuredPass": result["pass"]})
    elif forced.exists():
        forced.unlink()
    twin = compare_twins(cyc, cycle_id, train, log_path, heartbeat)
    if twin is not None:
        write_json(work / "gate" / "twin.json", twin)
    return result


def personas_order(cyc: Cycle, cycle_id: str, model: Path, calibration: Path, log_path: Path, heartbeat=None) -> Path:
    """The characters measured again with their calibrated knobs on fresh deals of the cycle seed
    (gate/personas-order.ts), twice the calibration's personas_pairs per segment like its final
    measure; the gate reads the order from this file."""
    out = cyc.work(cycle_id) / "gate" / "personas-order.json"
    g = cyc.cfg.gate
    pairs = str(2 * int(g["personas_pairs"]))
    cmd = ["node", ORDER_TS, "--model", str(model), "--calibration", str(calibration), "--pairs", pairs, "--seed", cycle_seed(cycle_id + ":personas"), "--out", str(out), "--threads", str(int(g["threads"])), "--stats", g["stats"]]
    proc.run(cmd, log_path, env={"ZAP_FACTS": str(cyc.work(cycle_id) / "facts-scratch.json")}, heartbeat=heartbeat)
    return out


def forced(cyc: Cycle, work: Path) -> str | None:
    """The --force of a local test, or None. A forced result outside minio mode is refused."""
    f = work / "gate" / "forced.json"
    if not f.exists():
        return None
    if cyc.cfg.mode != "minio":
        raise GuardError("a forced gate result exists outside minio mode")
    return read_json(f)["force"]


def compare_twins(cyc: Cycle, cycle_id: str, train: dict, log_path: Path, heartbeat=None) -> dict | None:
    """Candidate against its twin, twin against the second twin (seed floor), with compare.ts."""
    tw = train.get("twin")
    if not tw:
        return None
    work = cyc.work(cycle_id)
    seed = cycle_seed(cycle_id + ":twin")
    pairs = str(int(cyc.cfg.gate["panel_pairs"]))
    threads = str(int(cyc.cfg.gate["threads"]))
    env = {"ZAP_FACTS": str(work / "facts-scratch.json")}

    def run(a: str, b: str, name: str) -> dict:
        out = work / "gate" / f"{name}.json"
        proc.run(["node", COMPARE_TS, "--a", a, "--b", b, "--pairs", pairs, "--seed", seed, "--threads", threads, "--stats", cyc.cfg.gate["stats"], "--out", str(out)], log_path, env=env, heartbeat=heartbeat)
        return read_json(out)

    cand = train["export"]["file"]
    head = run(cand, tw["snapshot"], "twin-head-to-head")
    floor = run(tw["snapshot"], tw["floor"], "twin-seed-floor") if tw.get("floor") else None
    return {"sha256": sha256_file(Path(tw["snapshot"])), "headToHead": head, **seed_floor(cyc.state, cycle_id, floor)}


def seed_floor(state: dict, cycle_id: str, measured: dict | None) -> dict:
    """The card's seed floor: the one measured in this cycle, else the latest one carried from the
    cycle that measured it; and the noise scale, the root mean square distance from 0.5 of every
    floor measured so far (this one included)."""
    floors = [f["mean"] for f in state.get("seedFloors") or []]
    if measured is not None:
        floors.append(measured["mean"])
        floor, origin = {k: measured[k] for k in ("pairs", "mean", "lo", "hi")}, cycle_id
    elif state.get("seedFloor"):
        prev = state["seedFloor"]
        floor, origin = {k: prev[k] for k in ("pairs", "mean", "lo", "hi")}, prev["cycleId"]
    else:
        floor, origin = None, None
    noise = {"floors": len(floors), "rms": round(math.sqrt(sum((m - 0.5) ** 2 for m in floors) / len(floors)), 4)} if floors else None
    return {"seedFloor": floor, "seedFloorCycle": origin, "seedNoise": noise}
