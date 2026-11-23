"""init, publish, rollback and adopt (contract 3.9). Write order, so no reader sees a manifest that
points to a missing file:
* publish: models/vN.zapw, cards/vN.json, manifest.json, summary.json, status/training.json.
* rollback and window close: manifest.json, the cards involved, summary.json, status/training.json.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from . import card as cards
from . import explorer as explorers
from . import formats
from .build import card_data
from .config import ROOT
from .core import BUNDLE, MANIFEST_KEY, SUMMARY_KEY, Cycle, model_key, read_json, sha256_file, write_json, zapw_header
from .errors import CycleError, GuardError
from .gate import forced
from .lock import manifest_lock
from .storage import MODEL_TYPE, SUMMARY_CACHE
from .summary import build_summary


def window_open(manifest: dict, now: int) -> bool:
    return manifest.get("control") is not None and manifest.get("controlUntil") is not None and now < manifest["controlUntil"]


def ab_not_closed(cyc: Cycle) -> None:
    """Refuses while the last A/B window is still in state.json: after controlUntil it is closed only
    by the A/B check (final result in the card, or a rollback), never skipped by a new cycle."""
    ab = cyc.state.get("ab")
    if ab:
        raise GuardError(f"the A/B window of {ab['version']} is not closed yet; run ab first")


def write_summary(cyc: Cycle, manifest: dict, status: dict | None = None) -> dict:
    s = build_summary(cyc, manifest, status if status is not None else cyc.read_status())
    cyc.put_json(cyc.public, SUMMARY_KEY, s["schema"], s, SUMMARY_CACHE)
    return s


def bundled_version(cyc: Cycle, v: str) -> tuple[dict, bytes, dict]:
    """A bundled version (core.BUNDLE): its manifest, its bytes checked against it, and its card
    (the stored one, else a bootstrap card). Its local folder gets the file and, when present, the
    training run behind it."""
    if v not in BUNDLE:
        raise CycleError(f"storage.bundled: {v} is not in the bundle")
    b = BUNDLE[v]
    man = read_json(ROOT / b["manifest"])
    body = (ROOT / b["model"]).read_bytes()
    if man.get("version") != v or sha256_file(ROOT / b["model"]) != man["sha256"] or len(body) != man["bytes"]:
        raise CycleError(f"the bundled model {v} does not match its manifest")
    if b["card"]:
        card = formats.check("zap-card/1", read_json(ROOT / b["card"]))
        if card["version"] != v or card["model"]["sha256"] != man["sha256"]:
            raise CycleError(f"the stored card of {v} describes another file")
    else:
        card = cards.bootstrap_card(man, cyc.clock())
    vdir = cyc.version_dir(v)
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "model.zapw").write_bytes(body)
    if b["snapshot"] and (ROOT / b["snapshot"]).exists():
        shutil.copy(ROOT / b["snapshot"], vdir / "snapshot.zapw")
    if b["args"] and (ROOT / b["args"]).exists():
        args = read_json(ROOT / b["args"])
        args.setdefault("features", man.get("features", "v1"))
        write_json(vdir / "train-args.json", args)
    if b["checkpoint"] and (ROOT / b["checkpoint"]).exists() and b["snapshot"] and (ROOT / b["snapshot"]).exists():
        # Only the checkpoint of the snapshot's own iteration (as adopt checks it).
        it = (zapw_header(ROOT / b["snapshot"]).get("meta") or {}).get("iteration")
        if isinstance(it, int) and _checkpoint_iteration(ROOT / b["checkpoint"]) == it - 1:
            shutil.copy(ROOT / b["checkpoint"], vdir / "checkpoint.pt")
    return man, body, card


def init(cyc: Cycle) -> dict:
    """minio: creates the profile's buckets. Both modes, only when no manifest exists: every bundled
    version of storage.bundled (oldest first) with its card, the manifest with the last one current
    and no test window, and an ok status; and the local versions/vN folders."""
    made: list[str] = []
    if cyc.cfg.mode == "minio":
        made = cyc.store("admin").create_buckets()
    versions = list(cyc.cfg.storage["bundled"])
    bundled = [(v, *bundled_version(cyc, v)) for v in versions]
    with manifest_lock(cyc.cfg.data_dir):
        if cyc.manifest() is not None:
            return {"buckets": made, "initialized": False, "message": "a manifest already exists; nothing uploaded"}
        now = cyc.clock()
        models: dict[str, dict] = {}
        for v, man, body, card in bundled:
            cyc.models.put(model_key(v), body, MODEL_TYPE)
            cyc.put_card(card)
            models[v] = {**card["model"], "personas": man.get("personas") or {}, "createdAt": card["createdAt"]}
        current = versions[-1]
        manifest = {"schema": "zap-manifest/1", "current": current, "control": None, "controlShare": float(cyc.cfg.ab["share"]), "controlUntil": None, "updatedAt": now, "models": models}
        cyc.put_json(cyc.models, MANIFEST_KEY, "zap-manifest/1", manifest)
        names = " and ".join(versions) if len(versions) <= 2 else ", ".join(versions[:-1]) + " and " + versions[-1]
        msg = f"Bootstrap model {current} published; no training cycle has run yet." if len(versions) == 1 else f"Bundled models {names} published, {current} current; no training cycle has run yet."
        status = cyc.write_status("ok", "idle", msg, keep_failed=False)
    return {"buckets": made, "initialized": True, "manifest": manifest["current"], "versions": versions, "status": status["state"]}


def publish(cyc: Cycle, cycle_id: str) -> dict:
    """Needs this candidate's gate result. Failing: only cards/vN.json (rejected). Passing: refused
    while an A/B window is open or ended without its close; otherwise every file in the order above
    and the window opens."""
    work = cyc.work(cycle_id)
    if not (work / "gate" / "result.json").exists() or not (work / "train.json").exists():
        raise CycleError("publish needs the train and gate results of this cycle")
    train = read_json(work / "train.json")
    gate = formats.check("zap-gate/1", read_json(work / "gate" / "result.json"))
    version = train["version"]
    exp = train["export"]["manifest"]
    if gate["candidate"]["version"] != version or gate["candidate"]["sha256"] != exp["sha256"]:
        raise CycleError("the gate result belongs to another candidate")
    model_file = Path(train["export"]["file"])
    if sha256_file(model_file) != exp["sha256"]:
        raise CycleError("the candidate file changed after the gate")
    calibration = read_json(work / "gate" / "personas.json") if (work / "gate" / "personas.json").exists() else None
    order = read_json(work / "gate" / "personas-order.json") if (work / "gate" / "personas-order.json").exists() else None
    twin = read_json(work / "gate" / "twin.json") if (work / "gate" / "twin.json").exists() else None
    data = card_data(work / "tables")
    created = int(Path(train["export"]["file"]).stat().st_mtime * 1000)
    now = cyc.clock()
    force = forced(cyc, work)
    spec = read_json(work / "gate" / "spec.json") if (work / "gate" / "spec.json").exists() else None
    gate_passed = bool(gate["pass"]) if force is None else force == "pass"
    # The explorer guard: a file that can read the in-match statistics is promoted only with a
    # passing verdict of the explorer step for its network, whatever the config says.
    ex = explorers.promotable(cyc, work, train) if gate_passed else {"applies": explorers.can_read(zapw_header(model_file)), "ok": False, "guard": False, "result": _explorer_result(work), "why": "Not run: the gate rejected the candidate."}
    block = explorers.card_block(ex, train)
    card = cards.candidate_card(train, gate, data, calibration, twin, cycle_id, now, created, force, order, spec, cyc.cfg.mode, block)
    if card["result"] == "rejected":
        cyc.put_card(card)
        write_json(work / "card.json", card)
        if gate_passed and ex["guard"]:
            raise GuardError(f"{version} not promoted. {ex['why']}"[:1000])
        return {"version": version, "result": "rejected", "reasons": block["reasons"] if gate_passed and block else gate["reasons"]}
    with manifest_lock(cyc.cfg.data_dir):
        manifest = cyc.require_manifest()
        ab_not_closed(cyc)
        if window_open(manifest, now):
            raise GuardError(f"an A/B window is open until {manifest['controlUntil']}: no promotion before it closes")
        if version in manifest["models"]:
            raise CycleError(f"{version} is already in the manifest")
        if len(manifest["models"]) >= 500:
            raise CycleError("the manifest holds 500 models, the most it may")
        if gate["current"]["version"] != manifest["current"]:
            raise CycleError("the current version changed since the gate ran; run the gate again")
        until = now + int(cyc.cfg.ab["days"]) * 86_400_000
        previous = manifest["current"]
        cyc.models.put(model_key(version), model_file.read_bytes(), MODEL_TYPE)
        cyc.put_card(card)
        manifest["models"][version] = cards.manifest_entry(exp, now)
        manifest.update({"current": version, "control": previous, "controlShare": float(cyc.cfg.ab["share"]), "controlUntil": until, "updatedAt": now})
        cyc.put_json(cyc.models, MANIFEST_KEY, "zap-manifest/1", manifest)
        cyc.state["promotions"] = cyc.state.get("promotions", []) + [{"version": version, "at": now, "parent": previous}]
        cyc.state["ab"] = {"version": version, "control": previous, "from": now, "until": until}
        cyc.state.save()
        write_summary(cyc, manifest)
        cyc.write_status("ok", "idle", f"{version} promoted; A/B window with {previous} until the window closes.", cycle_id=cycle_id, finished_at=now, last_promotion={"version": version, "at": now}, keep_failed=False)
    keep_version_files(cyc, train, version, model_file)
    write_json(work / "card.json", card)
    return {"version": version, "result": "promoted", "control": previous, "until": until}


def _explorer_result(work: Path) -> dict | None:
    """The explorer step's result of a candidate the gate rejected, when the step wrote one."""
    p = work / "gate" / "explorer.json"
    return read_json(p) if p.exists() else None


def keep_version_files(cyc: Cycle, train: dict, version: str, model_file: Path) -> None:
    d = cyc.version_dir(version)
    d.mkdir(parents=True, exist_ok=True)
    shutil.copy(model_file, d / "model.zapw")
    shutil.copy(train["snapshot"], d / "snapshot.zapw")
    if train.get("checkpoint") and Path(train["checkpoint"]).exists():
        shutil.copy(train["checkpoint"], d / "checkpoint.pt")
    if train.get("argsFile") and Path(train["argsFile"]).exists():
        shutil.copy(train["argsFile"], d / "train-args.json")


def rollback(cyc: Cycle, target: str, ab_result: dict | None = None, reason: str | None = None) -> dict:
    """current = target, control and controlUntil = null; the version rolled back from gets
    result rolled-back and its A/B result when known. Never waits for a running cycle."""
    with manifest_lock(cyc.cfg.data_dir):
        manifest = cyc.require_manifest()
        if target not in manifest["models"]:
            raise CycleError(f"{target} is not in the manifest")
        now = cyc.clock()
        previous = manifest["current"]
        manifest.update({"current": target, "control": None, "controlUntil": None, "updatedAt": now})
        cyc.put_json(cyc.models, MANIFEST_KEY, "zap-manifest/1", manifest)
        window = cyc.state.get("ab")
        if ab_result is None and window and window.get("version") == previous:
            ab_result = last_ab(cyc, window)
        if previous != target:
            c = cyc.card(previous)
            if c is not None and c["result"] == "promoted":
                c["result"] = "rolled-back"
                c["resultAt"] = now
                c["reason"] = (reason or f"Rolled back to {target} by the owner.")[:500]
                if ab_result is not None:
                    c["ab"] = ab_result
                cyc.put_card(c)
        cyc.state["ab"] = None
        cyc.state.save()
        write_summary(cyc, manifest)
        keep_status(cyc, reason or f"Rolled back from {previous} to {target}.")
    cyc.ensure_version(target, manifest["models"][target])
    return {"current": target, "from": previous}


def last_ab(cyc: Cycle, window: dict) -> dict | None:
    """The A/B numbers of the last daily check of this window, for a rollback by hand."""
    from .ab import card_ab
    from .summary import inputs_path

    p = inputs_path(cyc)
    saved = read_json(p).get("ab") if p.exists() else None
    return card_ab(saved, window, True) if saved else None


def keep_status(cyc: Cycle, message: str) -> dict:
    """A new message and updatedAt; state and step stay (a cycle may be running)."""
    prev = cyc.read_status() or {}
    return cyc.write_status(prev.get("state", "ok"), prev.get("step", "idle"), message, keep_failed=False)


def close_window(cyc: Cycle, ab_result: dict) -> dict:
    """At controlUntil: final A/B result in the candidate's card, control and controlUntil to null."""
    with manifest_lock(cyc.cfg.data_dir):
        manifest = cyc.require_manifest()
        now = cyc.clock()
        version = manifest["current"]
        control = manifest["control"]
        manifest.update({"control": None, "controlUntil": None, "updatedAt": now})
        cyc.put_json(cyc.models, MANIFEST_KEY, "zap-manifest/1", manifest)
        c = cyc.card(version)
        if c is not None:
            c["ab"] = ab_result
            cyc.put_card(c)
        cyc.state["ab"] = None
        cyc.state.save()
        write_summary(cyc, manifest)
        keep_status(cyc, f"A/B window of {version} against {control} closed; {version} stays.")
    return {"current": version, "closed": control}


def adopt(cyc: Cycle, cycle_id: str, export_dir: Path, log_path: Path) -> dict:
    """An export-model.ts output (the M6 model of runbook step 10) becomes a candidate: exported
    again from its source with the next number and its safety net, then gate and publish."""
    from .train import export_candidate

    src_man = read_json(export_dir / "manifest.json")
    source = ROOT / src_man["source"] if not Path(src_man["source"]).is_absolute() else Path(src_man["source"])
    if not source.exists():
        raise CycleError(f"the export's source {src_man['source']} is missing")
    work = cyc.work(cycle_id)
    run_dir = source.parent.parent if source.parent.name in ("league", "export") else source.parent
    header = zapw_header(source)
    it = (header.get("meta") or {}).get("iteration")
    # Before the export: a run of the resume chain without its files stops here, not after minutes of calibration.
    seconds = run_seconds(run_dir, it)
    manifest = cyc.require_manifest()
    parent = manifest["current"]
    version = cyc.next_version(manifest)
    exp = export_candidate(cyc, work, source, version, src_man.get("adapt"), log_path, f"adopted from {src_man['source']}")
    args_file = run_dir / "args.json"
    args = read_json(args_file) if args_file.exists() else {}
    checkpoint = run_dir / "checkpoint.pt"
    ck_ok = checkpoint.exists() and _checkpoint_iteration(checkpoint) == (it - 1 if isinstance(it, int) else None)
    argv = []
    for k, v in args.items():
        if v is None or v is False or v == "":
            continue
        argv += [f"--{k.replace('_', '-')}"] + ([] if v is True else [str(v)])
    train = {
        "cycleId": cycle_id,
        "version": version,
        "parent": parent,
        "initFrom": str(source),
        "snapshot": str(source),
        "checkpoint": str(checkpoint) if ck_ok else None,
        "argsFile": str(args_file) if args_file.exists() else None,
        "export": {"file": str(work / "export" / f"zap-{version}.zapw"), "manifest": exp},
        "training": {"args": argv, "iterations": int(it) if isinstance(it, int) else 0, "seconds": seconds, "seedBase": str(args.get("seed_base", "00"))[:2], "leagueFiles": [], "humanModel": None, "commit": None},
        "setups": {},
        "twin": None,
    }
    write_json(work / "train.json", train)
    return train


def run_seconds(run_dir: Path, iteration: int | None) -> float:
    """Training time of an adopted run up to its snapshot, over the whole chain of runs it resumed
    from: the self-play, learning and evaluation seconds that training/train.py logged in each run's
    metrics.jsonl (the last line of an iteration counts, if a run logged it twice). A run with
    resume_from in its args.json (train.py --resume-from) counts its own iterations from the one it
    resumed at (resumed-from.json: the checkpoint's iteration plus 1; without that file, the first
    iteration it logged) up to before `iteration`, and the run it resumed from counts the iterations
    before that one, and so on. A run of the chain without its metrics.jsonl is an error naming the
    file, so the card never counts part of the chain as the whole. 0 when the adopted run has no
    metrics.jsonl or the snapshot has no iteration: zap-card/1 has no null for training.seconds."""
    if not isinstance(iteration, int) or not (run_dir / "metrics.jsonl").exists():
        return 0
    total = 0.0
    seen: set[Path] = set()
    run, upto = Path(run_dir), iteration
    while True:
        if run.resolve() in seen:
            raise CycleError(f"the runs resume from each other in a loop at {run}")
        seen.add(run.resolve())
        path = run / "metrics.jsonl"
        if not path.exists():
            raise CycleError(f"{path} is missing: the card's training time counts every run of the resume chain")
        last: dict[int, dict] = {}
        for line in path.read_text().splitlines():
            if line.strip():
                m = json.loads(line)
                if isinstance(m.get("iteration"), int) and m["iteration"] < upto:
                    last[m["iteration"]] = m
        if len(seen) > 1 and not (run / "args.json").exists():
            raise CycleError(f"{run / 'args.json'} is missing: it says whether that run resumed from another one")
        args = read_json(run / "args.json") if (run / "args.json").exists() else {}
        src = args.get("resume_from") or ""
        start = 0
        if src:
            resumed = run / "resumed-from.json"
            it = (read_json(resumed).get("checkpoint") or {}).get("iteration") if resumed.exists() else None
            start = it + 1 if isinstance(it, int) else min(last, default=upto)
        total += sum(float(m.get(k) or 0) for i, m in last.items() if i >= start for k in ("selfplay_seconds", "learn_seconds", "eval_seconds"))
        if not src:
            return round(total, 1)
        run = ROOT / src if not Path(src).is_absolute() else Path(src)
        upto = start


def _checkpoint_iteration(path: Path) -> int | None:
    try:
        import torch

        ck = torch.load(path, weights_only=True, map_location="cpu")
        return int(ck.get("extra", {}).get("iteration"))
    except Exception:
        return None
