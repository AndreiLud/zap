"""train (contract 3.7): the candidate starts from the current version and trains with every panel
member in its league; then export, calibration of the characters and export with their knobs.

The last promoted versions stay in every run's league for the whole run (train.py --league-fixed).
Once the human behaviour model passed its test, the candidate meets it as its own league kind
'human', as opponent and as partner ([human.model] league_share of the mix, taken from 'current');
the twins run the plain mix with the same league files, seed and iteration count, and are compared
as int8 files (zapcycle/human/twin.py).

With [gate] stats = "live" every run trains with the feints league ([train] league_mix_live,
feint_hands, feint_evidence: the mix and switch points of training/runs/m6-adaptive-r/args.json, the
network that passed the explorer test), and a candidate that will run the explorer step leaves it
[explorer] reserve_hours before the cycle's deadline.
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from . import proc
from .config import ROOT
from .context import HumanResult
from .core import BUNDLED_MANIFEST, Cycle, git_commit, read_json, rel, sha256_file, write_json, zapw_header
from .errors import CycleError
from .explorer import config_mismatch, step_due
from .human import twin as twin_parts

PRIORS_FILE = "ai/models/opponent-priors.json"
GATE_RESERVE_HOURS = 2.0


def seed_base(cycle_id: str) -> str:
    """First two hex characters of the cycle seed (SHA-256 of the cycle id)."""
    import hashlib

    return hashlib.sha256(cycle_id.encode()).hexdigest()[:2]


def bump_seed(s: str) -> str:
    return f"{(int(s, 16) + 1) % 256:02x}"


def current_args(cyc: Cycle, version: str, vdir: Path) -> dict:
    """The training arguments of the current version: train-args.json, else the header's facts."""
    p = vdir / "train-args.json"
    if p.exists():
        return read_json(p)
    h = zapw_header(vdir / "model.zapw")
    return {"features": h["features"], "hidden": ",".join(str(x) for x in h["hidden"])}


def priors_path(cyc: Cycle, header: dict, work: Path) -> str | None:
    """The opponent priors of a v2 model: the project file when its hash matches, else meta.priors written out."""
    meta = header.get("meta") or {}
    if header["features"] == "v1":
        return None
    if meta.get("priorsSha256") and sha256_file(ROOT / PRIORS_FILE) == meta["priorsSha256"]:
        return PRIORS_FILE
    if not meta.get("priors"):
        raise CycleError("the current model has features v2 but no priors in its meta")
    out = work / "runs" / "priors.json"
    write_json(out, meta["priors"])
    return rel(out)


def init_actor(cyc: Cycle, vdir: Path, out: Path, log_path: Path) -> str:
    ck = vdir / "checkpoint.pt"
    src = ["--checkpoint", str(ck)] if ck.exists() else ["--zapw", str(vdir / ("snapshot.zapw" if (vdir / "snapshot.zapw").exists() else "model.zapw"))]
    env = {"PYTHONPATH": str(ROOT / "training" / "cycle")}
    proc.run(["python", "-m", "zapcycle.init_actor", *src, "--out", str(out)], log_path, env=env)
    return rel(src[1])


def with_human(mix: str, share: float) -> str:
    """The league mix with `share` moved from 'current' to 'human' (the human model as opponent and,
    through the partner swap, as partner)."""
    parts = dict(p.split("=") for p in mix.split(",") if p)
    cur = float(parts.get("current", 0))
    if share <= 0 or share > cur:
        raise CycleError(f"human league share {share} must be above 0 and at most the current share {cur}")
    parts["current"] = f"{cur - share:.4f}".rstrip("0").rstrip(".")
    parts["human"] = f"{share:.4f}".rstrip("0").rstrip(".")
    return ",".join(f"{k}={v}" for k, v in parts.items())


def human_share(cyc: Cycle) -> float:
    """[human.model] league_share: the share of training matches against the human model."""
    v = (cyc.cfg.human.get("model") or {}).get("league_share")
    if not isinstance(v, (int, float)):
        raise CycleError("config: human.model.league_share is missing")
    return float(v)


def league_files(cyc: Cycle) -> list[str]:
    """The last league_versions promoted versions: files that stay in the league for the whole run
    (train.py --league-fixed), after the window of the run's own snapshots. The human model is not
    one of them: it has its own kind in the mix (with_human)."""
    m = cyc.require_manifest()
    files = []
    for v in [v for v in cyc.promoted() if v != "v1"][-int(cyc.cfg.train["league_versions"]) :]:
        if v in m["models"]:
            files.append(rel(cyc.ensure_version(v, m["models"][v]) / "model.zapw"))
    return files


def train_command(cyc: Cycle, run: Path, args: dict, priors: str | None, init: Path, seed: str, max_hours: float, fixed: list[str], iters: int | None = None, human: Path | None = None) -> list[str]:
    """fixed: league files for the whole run. iters: the twins take the candidate's real iteration
    count (same compute); None: the config's. human: the human model, with its share of the mix; the
    twins run the same mix without it."""
    t = cyc.cfg.train
    features = args.get("features", "v1")
    # With the statistics live the league is the feints league of the network that passed the
    # explorer test ([train] league_mix_live, feint_hands, feint_evidence, from
    # training/runs/m6-adaptive-r/args.json), so later candidates keep that training.
    live = cyc.cfg.gate.get("stats") == "live"
    mix = t["league_mix_live"] if live else t["league_mix"]
    cmd = [
        "python", "training/train.py",
        "--run", rel(run),
        "--features", features,
    ]
    if priors:
        cmd += ["--priors", priors]
    cmd += [
        "--init-actor", rel(init),
        "--critic-warmup", str(t["critic_warmup"]),
        "--iters", str(t["iters"] if iters is None else iters),
        "--decisions", str(t["decisions"]),
        "--workers", str(t["workers"]),
        "--threads", str(t["threads"]),
        "--hidden", str(args.get("hidden", "256,256")),
        "--league-mix", with_human(mix, human_share(cyc)) if human else mix,
        "--league-size", "8",
        "--league-fixed", ",".join(fixed),
        "--seed-base", seed,
        "--max-hours", f"{max_hours:.3f}",
    ]
    if features == "v2":
        cmd += ["--adapt-beta", str(args.get("adapt_beta", 0.0)), "--adapt-nw", str(args.get("adapt_nw", 2.0))]
    if human:
        cmd += ["--human-model", rel(human)]
    if live:
        cmd += ["--feint-hands", t["feint_hands"], "--feint-evidence", t["feint_evidence"]]
    return cmd + list(t["fixed_args"])


def final_snapshot(run: Path) -> Path:
    """league/it<last>.zapw when it holds the final iteration, else current.zapw (same weights)."""
    cur = run / "current.zapw"
    if not cur.exists():
        raise CycleError(f"{run.name}: training wrote no model")
    it = (zapw_header(cur).get("meta") or {}).get("iteration")
    snap = run / "league" / f"it{int(it):06d}.zapw" if isinstance(it, int) else None
    return snap if snap is not None and snap.exists() else cur


def iterations(run: Path) -> int:
    p = run / "metrics.jsonl"
    return sum(1 for line in p.read_text().splitlines() if line.strip()) if p.exists() else 0


def export_candidate(cyc: Cycle, work: Path, snapshot: Path, version: str, adapt: dict | None, log_path: Path, note: str, heartbeat=None) -> dict:
    """export-model.ts, calibrate-personas.ts, export again with the calibrated knobs."""
    out = work / "export"
    gate = work / "gate"
    gate.mkdir(parents=True, exist_ok=True)
    env = {"ZAP_FACTS": str(work / "facts-scratch.json")}
    base = ["node", "ai/bench/export-model.ts", str(snapshot), str(out), "--version", version, "--note", note]
    if adapt:
        base += ["--adapt", f"{adapt['bmax']},{adapt['nHalf']}"]
    proc.run(base, log_path, env=env)
    personas = gate / "personas.json"
    # The characters play as the room serves them (gate.stats), on the gate's threads.
    g = cyc.cfg.gate
    proc.run(["node", "ai/bench/calibrate-personas.ts", str(out / f"zap-{version}.zapw"), str(g["personas_pairs"]), "--out", str(personas), "--threads", str(int(g["threads"])), "--stats", g["stats"]], log_path, env=env, heartbeat=heartbeat)
    proc.run(base + ["--personas", str(personas)], log_path, env=env)
    man = read_json(out / "manifest.json")
    if man.get("version") != version:
        raise CycleError("the export manifest names another version")
    return man


def run_train(cyc: Cycle, cycle_id: str, human: HumanResult | None, started_ms: int, log_path: Path, heartbeat=None) -> dict:
    work = cyc.work(cycle_id)
    manifest = cyc.require_manifest()
    current = manifest["current"]
    entry = manifest["models"][current]
    vdir = cyc.ensure_version(current, entry)
    args = current_args(cyc, current, vdir)
    header = zapw_header(vdir / ("snapshot.zapw" if (vdir / "snapshot.zapw").exists() else "model.zapw"))
    # A version in play that can read gives a candidate that can read: without the explorer step the
    # guard would refuse it after the whole training, so the cycle stops here and says why.
    mismatch = config_mismatch(cyc.cfg, current, header["features"], entry.get("adapt"))
    if mismatch:
        raise CycleError(mismatch)
    if header["features"] != args.get("features", "v1"):
        args["features"] = header["features"]
    runs = work / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    init = runs / "init-actor.pt"
    init_src = init_actor(cyc, vdir, init, log_path)
    priors = priors_path(cyc, header, work)
    seed = seed_base(cycle_id)

    human_model = human.human_model if human else None
    twin_on = cyc.cfg.train["twin"] == "auto" and human_model is not None
    floor_due = twin_on and (cyc.state.get("seedFloor") is None or int(cyc.state.get("cyclesSinceSeedFloor", 0)) + 1 >= int(cyc.cfg.train["seed_floor_every"]))
    plan = [("candidate", seed, True)] + ([("twin", seed, False)] if twin_on else []) + ([("twin-b", bump_seed(seed), False)] if floor_due else [])

    deadline = started_ms / 1000 + float(cyc.cfg.schedule["max_cycle_hours"]) * 3600
    # A candidate that will run the explorer step (zapcycle/explorer.py) leaves it its hours too.
    explorer_h = float(cyc.cfg.explorer.get("reserve_hours", 0)) if step_due(cyc.cfg, header["features"], entry.get("adapt")) else 0.0
    t0 = time.time()
    results = {}
    fixed = league_files(cyc)
    for i, (name, s, meets_human) in enumerate(plan):
        run = runs / name
        if run.exists():
            shutil.rmtree(run)
        left_h = (deadline - time.time()) / 3600 - GATE_RESERVE_HOURS - explorer_h
        budget = min(float(cyc.cfg.train["max_hours_per_run"]), left_h / (len(plan) - i))
        if budget <= 0.01:
            raise CycleError("time limit: no time left for training")
        iters = None if name == "candidate" else twin_parts.same_compute(cyc.cfg.train["iters"], results["candidate"]["iterations"])
        cmd = train_command(cyc, run, args, priors, init, s, budget, fixed, iters, human_model if meets_human else None)
        r0 = time.time()
        proc.run(cmd, log_path, deadline=deadline, heartbeat=heartbeat)
        results[name] = {"run": str(run), "seconds": round(time.time() - r0, 1), "iterations": iterations(run), "leagueFiles": fixed, "args": cmd[2:], "seedBase": s}

    cand = results["candidate"]
    run = Path(cand["run"])
    metrics = [json.loads(line) for line in (run / "metrics.jsonl").read_text().splitlines() if line.strip()]
    setups: dict[str, int] = {}
    for m in metrics:
        for k, v in (m.get("setups") or {}).items():
            setups[k] = setups.get(k, 0) + v
    version = cyc.next_version(manifest)
    snapshot = final_snapshot(run)
    adapt = entry.get("adapt") if header["features"] == "v2" else None
    exp = export_candidate(cyc, work, snapshot, version, adapt, log_path, f"candidate of cycle {cycle_id}", heartbeat)
    twin = None
    if "twin" in results:
        # The twins are compared in int8, the form of the candidate's export and of a served model.
        q = work / "export-twin"
        floor = twin_parts.quantize(final_snapshot(Path(results["twin-b"]["run"])), q / "twin-b.zapw") if "twin-b" in results else None
        twin = {
            "run": results["twin"]["run"],
            "snapshot": str(twin_parts.quantize(final_snapshot(Path(results["twin"]["run"])), q / "twin.zapw")),
            "floor": str(floor) if floor else None,
            "seedBase": {k: v["seedBase"] for k, v in results.items()},
            "iterations": {k: v["iterations"] for k, v in results.items()},
            "leagueFiles": {k: v["leagueFiles"] for k, v in results.items()},
        }
    out = {
        "cycleId": cycle_id,
        "version": version,
        "parent": current,
        "initFrom": init_src,
        "snapshot": str(snapshot),
        "checkpoint": str(run / "checkpoint.pt"),
        "argsFile": str(run / "args.json"),
        "export": {"file": str(work / "export" / f"zap-{version}.zapw"), "manifest": exp},
        "training": {
            "args": cand["args"],
            "iterations": cand["iterations"],
            "seconds": round(time.time() - t0, 1),
            "seedBase": seed,
            "leagueFiles": cand["leagueFiles"],
            "humanModel": human.human_model_report if human and human.human_model_report else None,
            "commit": git_commit(),
        },
        "setups": setups,
        "twin": twin,
    }
    write_json(work / "train.json", out)
    return out


def bundled_manifest() -> dict:
    return read_json(ROOT / BUNDLED_MANIFEST)
