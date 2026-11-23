"""Command line of the cycle: python training/cycle/cycle.py --config <toml> <command> ...

Exit codes: 0 done, 1 error, 2 refused by a guard, 3 lock busy. --json prints one JSON object.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import human
from .ab import run_ab
from .bridge import pull, push
from .build import run_build
from .config import load_config
from .context import CycleContext, HumanResult
from .core import Cycle, iso, new_cycle_id, read_json, write_json
from .errors import CycleError, GuardError
from .explorer import run_explorer
from .gate import run_gate
from .index import Index
from .lock import cycle_lock
from .logs import prune_run_logs, run_log_path, setup_logging
from .publish import ab_not_closed, adopt, init, publish, rollback, window_open
from .summary import save_inputs
from .sync import sync
from .train import run_train


class LazyBucket:
    """A bucket of a role, opened on first use (commands that never touch storage need no keys)."""

    def __init__(self, cyc: Cycle, role: str, kind: str):
        self._cyc, self._role, self._kind = cyc, role, kind

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cyc.bucket(self._role, self._kind), name)


def context(cyc: Cycle, cycle_id: str) -> CycleContext:
    work = cyc.work(cycle_id)
    return CycleContext(
        config=cyc.cfg,
        profile=cyc.cfg.profile,
        cycle_id=cycle_id,
        now_ms=cyc.clock(),
        data_dir=cyc.cfg.data_dir,
        work_dir=work,
        tables_dir=work / "tables",
        events=LazyBucket(cyc, "events", "events"),
        models=LazyBucket(cyc, "publish", "models"),
        public=LazyBucket(cyc, "publish", "public"),
        log=cyc.log,
        state=cyc.state,
    )


def save_human(work: Path, h: HumanResult) -> None:
    write_json(work / "human" / "result.json", {"layers": h.layers, "humanModel": str(h.human_model) if h.human_model else None, "report": h.human_model_report, "summary": h.summary})


def load_human(work: Path) -> HumanResult | None:
    p = work / "human" / "result.json"
    if not p.exists():
        return None
    d = read_json(p)
    return HumanResult(layers=d["layers"], human_model=Path(d["humanModel"]) if d["humanModel"] else None, human_model_report=d["report"], summary=d.get("summary") or {})


class Steps:
    """The steps of one cycle, each announced in the remote status; a failure marks it failed."""

    def __init__(self, cyc: Cycle, cycle_id: str, started_at: int):
        self.cyc = cyc
        self.cycle_id = cycle_id
        self.started_at = started_at
        self.log_path = run_log_path(cyc.cfg.logs_dir, cycle_id)
        self.current = "idle"

    def status(self, step: str, message: str) -> None:
        self.current = step
        self.cyc.write_status("running", step, message, cycle_id=self.cycle_id, started_at=self.started_at)

    def heartbeat(self) -> None:
        self.cyc.write_status("running", self.current, f"Cycle {self.cycle_id}: still at step {self.current}.", cycle_id=self.cycle_id, started_at=self.started_at)

    def run(self, step: str, fn: Callable[[], Any]) -> Any:
        self.status(step, f"Cycle {self.cycle_id}: step {step}.")
        self.cyc.log.info(f"cycle {self.cycle_id}: {step}")
        return fn()

    def fail(self, e: Exception) -> None:
        msg = f"Cycle {self.cycle_id} failed at step {self.current}: {e}"
        self.cyc.log.error(msg)
        try:
            self.cyc.write_status("failed", self.current, msg, cycle_id=self.cycle_id, started_at=self.started_at, finished_at=self.cyc.clock(), keep_failed=False)
        except Exception as e2:  # the status write itself failed: keep the first error
            self.cyc.log.error(f"could not write the failed status: {type(e2).__name__}")


def records_count(cyc: Cycle) -> int:
    idx = Index(cyc.cfg.data_dir / "index.sqlite")
    try:
        return idx.count()
    finally:
        idx.close()


def do_sync(cyc: Cycle) -> dict:
    out = sync(cyc)
    return out


def do_build(cyc: Cycle, st: Steps) -> dict:
    tables = cyc.work(st.cycle_id) / "tables"
    return run_build(cyc, tables, st.log_path)


def do_human(cyc: Cycle, st: Steps) -> HumanResult:
    ctx = context(cyc, st.cycle_id)
    h = human.run_human_layers(ctx)
    work = cyc.work(st.cycle_id)
    save_human(work, h)
    save_inputs(cyc, work / "tables" / "records.jsonl", h.layers, (h.summary or {}).get("playerTypes"))
    return h


MAX_SEED_FLOORS = 50  # seed floors kept in state.json for the noise scale of the cards


def open_data_after_promotion(cyc: Cycle, st: Steps, env: dict | None = None) -> dict:
    """The plan's open data "after each promoted version": after a promotion, with the layer on
    (OPEN_DATA_ENABLED true and enough valid matches), the cycle uploads a release on its own.

    It syncs first. When the newest export is the one the cycle's tables came from, the package the
    human step built goes as it is; otherwise the tables, the readings and the package are built again
    from the newest export, so people who deleted their data or left open data since are out. The
    upload then runs the owner's checks (opendata.check_fresh, a package with matches). The first
    release is always the owner's own command (open-data, a look inside the zip, the
    re-identification check, open-data --upload): until one exists the cycle only builds the package.
    In the local profiles, and for a test package, the upload is a dry run. Never raises: the
    promotion stands whatever happens here, and the answer says what did."""
    import os

    from .human import dry_run, first_release_done, upload_package
    from .human import flags as hflags
    from .human import opendata, priors
    from .human.common import tables_summary

    env = os.environ if env is None else env
    try:
        ctx = context(cyc, st.cycle_id)
        summary = tables_summary(ctx)
        state = opendata.gate(ctx, summary, env)
        # A cycle without tables (adopt) is judged on the tables built below.
        if not state["on"] and (summary or not opendata.enabled(env)):
            return {"status": "off", "why": state["why"]}
        sync(cyc)
        ctx = context(cyc, st.cycle_id)
        latest = ctx.state.get("latestExport") or {}
        found = opendata.latest_package(ctx)
        rebuilt = found is None or found[1].get("exportSha256") != latest.get("sha256")
        if rebuilt:
            run_build(cyc, ctx.tables_dir, st.log_path)
            summary = tables_summary(ctx)
            exclude = hflags.flagged_groups(ctx, latest.get("date"))
            priors.run_profiles(ctx, exclude)
            state, _ = opendata.run_open_data(ctx, exclude, priors.readings(ctx), summary, env)
            if not state["on"]:
                return {"status": "off", "why": state["why"], "rebuilt": True}
            found = opendata.latest_package(ctx)
        if found is None or found[1]["matches"] == 0:
            return {"status": "empty", "why": "No cell reached 20 people: nothing to release.", "rebuilt": rebuilt}
        dry = dry_run(ctx, found[1])
        if not first_release_done(ctx, dry):
            return {"status": "waiting", "why": "The first release is the owner's: look inside the zip, then open-data --upload.", "zip": str(found[0]), "rebuilt": rebuilt}
        out = upload_package(ctx, env, auto=True)
        cyc.log.info(f"open data after the promotion: {out['upload']['tag']} ({'dry run' if dry else 'uploaded'})")
        return {"status": "uploaded", "rebuilt": rebuilt, **out}
    except Exception as e:  # the promotion stands; the owner can run open-data by hand
        cyc.log.error(f"open data after the promotion failed: {type(e).__name__}: {e}")
        return {"status": "failed", "error": f"{type(e).__name__}: {e}"[:300]}


def finish_ok(cyc: Cycle, st: Steps, pub: dict) -> dict:
    now = cyc.clock()
    if pub["result"] == "rejected":
        first = (pub.get("reasons") or ["failed the gate"])[0]
        cyc.write_status("ok", "idle", f"Cycle {st.cycle_id} ended: {pub['version']} rejected. {first}", cycle_id=st.cycle_id, started_at=st.started_at, finished_at=now, keep_failed=False)
    twin = cyc.work(st.cycle_id) / "gate" / "twin.json"
    if twin.exists():
        t = read_json(twin)
        if t.get("seedFloor") and t.get("seedFloorCycle") == st.cycle_id:
            floor = {"cycleId": st.cycle_id, **t["seedFloor"]}
            cyc.state["seedFloor"] = floor
            cyc.state["seedFloors"] = (list(cyc.state.get("seedFloors") or []) + [floor])[-MAX_SEED_FLOORS:]
            cyc.state["cyclesSinceSeedFloor"] = 0
        else:
            cyc.state["cyclesSinceSeedFloor"] = int(cyc.state.get("cyclesSinceSeedFloor", 0)) + 1
        cyc.state.save()
    if pub.get("result") == "promoted":
        pub["openData"] = open_data_after_promotion(cyc, st)
    cyc.prune_work()
    return pub


def cmd_run(cyc: Cycle, force: str | None) -> dict:
    if force is not None and cyc.cfg.mode != "minio":
        raise GuardError("--force works only in minio mode")
    now = cyc.clock()
    manifest = cyc.require_manifest()
    if window_open(manifest, now):
        raise GuardError(f"an A/B window is open until {iso(manifest['controlUntil'])}: no cycle before it closes")
    ab_not_closed(cyc)
    cycle_id = new_cycle_id(now)
    with cycle_lock(cyc.cfg.data_dir, cycle_id, now):
        cyc.state.update(lastCycleId=cycle_id, lastCycleStartedAt=now)
        cyc.state.save()
        prune_run_logs(cyc.cfg.logs_dir)
        st = Steps(cyc, cycle_id, now)
        try:
            synced = st.run("sync", lambda: do_sync(cyc))
            cyc.state["recordsAtLastCycle"] = records_count(cyc)
            cyc.state.save()
            built = st.run("build", lambda: do_build(cyc, st))
            h = st.run("human", lambda: do_human(cyc, st))
            trained = st.run("train", lambda: run_train(cyc, cycle_id, h, now, st.log_path, st.heartbeat))
            gate = st.run("gate", lambda: run_gate(cyc, cycle_id, st.log_path, force=force, heartbeat=st.heartbeat))
            ex = do_explorer(cyc, st, now)
            pub = st.run("publish", lambda: publish(cyc, cycle_id))
            finish_ok(cyc, st, pub)
        except Exception as e:
            st.fail(e)
            # A failed cycle prunes too: its own folder is the newest and stays whole for a rerun,
            # every older one loses its per person tables as after a cycle that ends ok.
            prune_quietly(cyc)
            raise
    return {"cycleId": cycle_id, "sync": synced, "build": built, "version": trained["version"], "setups": trained["setups"], "gate": {"pass": gate["pass"], "sprt": gate["sprt"]["decision"], "reasons": gate["reasons"]}, "explorer": explorer_summary(ex), "publish": pub}


def do_explorer(cyc: Cycle, st: Steps, started_ms: int | None = None, lift: str | None = None) -> dict | None:
    """The explorer step of the gate (zapcycle/explorer.py) for a candidate that can read, announced
    in the status as part of the gate; its subprocesses stop at the cycle's deadline. lift: the
    owner's reason to measure a network that failed before (--lift-failure, recorded on the card)."""
    deadline = None if started_ms is None else started_ms / 1000 + float(cyc.cfg.schedule["max_cycle_hours"]) * 3600
    return run_explorer(cyc, st.cycle_id, st.log_path, st.heartbeat, deadline, on_start=lambda: st.status("gate", f"Cycle {st.cycle_id}: step gate, explorer test."), lift=lift)


def explorer_summary(ex: dict | None) -> dict | None:
    if ex is None:
        return None
    return {"ran": ex["ran"], "source": ex["source"], "pass": ex["pass"], "verdicts": len(ex["verdicts"]), "pending": ex["pending"], "newFailures": ex["newFailures"], "reasons": ex.get("reasons") or [], "ppo": ex.get("ppo"), "lifted": ex.get("lifted"), "seconds": ex["seconds"]}


def prune_quietly(cyc: Cycle) -> None:
    """prune_work, logging instead of raising, so it never hides the error of the step before."""
    try:
        cyc.prune_work()
    except Exception as e:
        cyc.log.error(f"could not prune the work folders: {type(e).__name__}")


def one_step(cyc: Cycle, cycle_id: str | None, step: str, fn: Callable[[Steps], Any], new_id: bool = False, prune: bool = False) -> Any:
    """One step under the cycle lock. prune: afterwards (also after a failure) only the newest work
    folder keeps its per person tables, as at the end of a cycle."""
    now = cyc.clock()
    cid = cycle_id or (new_cycle_id(now) if new_id else cyc.latest_work())
    with cycle_lock(cyc.cfg.data_dir, cid, now):
        st = Steps(cyc, cid, now)
        try:
            return st.run(step, lambda: fn(st))
        except Exception as e:
            st.fail(e)
            raise
        finally:
            if prune:
                prune_quietly(cyc)


def cmd_status(cyc: Cycle) -> dict:
    out: dict = {"profile": cyc.cfg.profile, "mode": cyc.cfg.mode, "state": dict(cyc.state)}
    out["state"].pop("receiptEtags", None)
    try:
        out["status"] = cyc.read_status()
        m = cyc.manifest()
        # controlShare: tools/docs/record-release.ts records the window's share from this output.
        out["manifest"] = None if m is None else {"current": m["current"], "control": m["control"], "controlShare": m.get("controlShare"), "controlUntil": iso(m["controlUntil"]), "models": sorted(m["models"], key=lambda v: int(v[1:]))}
        rec = sorted(o.key for o in cyc.events.list("receipts/"))
        out["receipt"] = None
        if rec:
            obj = cyc.events.get(rec[-1], 1024 * 1024)
            out["receipt"] = {"key": rec[-1], "jobs": {k: v["status"] for k, v in json.loads(obj.body)["jobs"].items()}} if obj else None
    except CycleError as e:
        out["remote"] = f"unavailable: {e}"
    except Exception as e:
        out["remote"] = f"unavailable: {type(e).__name__}"
    receipts = sorted((cyc.cfg.data_dir / "receipts").glob("*.json"))
    out["localReceipt"] = receipts[-1].name if receipts else None
    return out


def cmd_scheduler(cfg, config_path: str, args) -> dict:
    from .scheduler import Scheduler, count_new_records

    def lister(now: datetime) -> int:
        return count_new_records(Cycle(cfg), now)

    def failed(msg: str) -> None:
        c = Cycle(cfg)
        prev = c.read_status() or {}
        c.write_status("failed", prev.get("step", "idle"), msg, finished_at=c.clock(), keep_failed=False)

    start = None
    if args.now:
        start = datetime.fromisoformat(args.now)
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
    s = Scheduler(cfg, config_path, dry_run=args.dry_run, lister=lister, status_failed=failed)
    decisions = s.loop(start, args.ticks, args.tick_advance)
    return {"ticks": args.ticks, "decisions": len(decisions)}


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="cycle.py", description="Zap training cycle")
    ap.add_argument("--config", required=True, help="training/cycle/config/<profile>.toml")
    ap.add_argument("--json", action="store_true", help="print one JSON object on stdout")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("sync")
    for name in ("build", "train", "publish"):
        sub.add_parser(name).add_argument("--cycle")
    g = sub.add_parser("gate")
    g.add_argument("--cycle")
    g.add_argument("--candidate")
    g.add_argument("--force", choices=["pass", "fail"])
    e = sub.add_parser("explorer")
    e.add_argument("--cycle")
    e.add_argument("--lift-failure", metavar="REASON", help="the owner's reason to measure a network that failed the explorer test before (recorded on the card)")
    sub.add_parser("rollback").add_argument("version")
    a = sub.add_parser("adopt")
    a.add_argument("export_dir")
    a.add_argument("--force", choices=["pass", "fail"])
    a.add_argument("--lift-failure", metavar="REASON", help="the owner's reason to measure a network that failed the explorer test before (recorded on the card)")
    sub.add_parser("ab")
    sub.add_parser("run").add_argument("--force", choices=["pass", "fail"])
    sub.add_parser("status")
    s = sub.add_parser("scheduler")
    s.add_argument("--now")
    s.add_argument("--ticks", type=int)
    s.add_argument("--tick-advance", type=float)
    s.add_argument("--dry-run", action="store_true")
    b = sub.add_parser("bridge")
    b.add_argument("direction", choices=["push", "pull"])
    b.add_argument("--state", required=True)
    sub.add_parser("human-model")
    sub.add_parser("priors")
    f = sub.add_parser("flags")
    f.add_argument("action", choices=["list", "confirm", "clear", "push"])
    f.add_argument("ref", nargs="?")
    sub.add_parser("player-types")
    sub.add_parser("open-data").add_argument("--upload", action="store_true")
    return ap


def dispatch(args, cfg, cyc: Cycle) -> Any:
    c = args.cmd
    if c == "init":
        return init(cyc)
    if c == "sync":
        return one_step(cyc, None, "sync", lambda st: do_sync(cyc), new_id=True)
    if c == "build":
        return one_step(cyc, args.cycle, "build", lambda st: do_build(cyc, st), new_id=True, prune=True)
    if c == "train":
        return one_step(cyc, args.cycle, "train", lambda st: run_train(cyc, st.cycle_id, load_human(cyc.work(st.cycle_id)), st.started_at, st.log_path, st.heartbeat))
    if c == "gate":
        return one_step(cyc, args.cycle, "gate", lambda st: run_gate(cyc, st.cycle_id, st.log_path, Path(args.candidate) if args.candidate else None, args.force, st.heartbeat))
    if c == "explorer":
        def ex(st: Steps) -> dict:
            r = do_explorer(cyc, st, lift=args.lift_failure)
            return {"applies": False, "why": "the candidate's file cannot read the in-match statistics"} if r is None else explorer_summary(r)
        return one_step(cyc, args.cycle, "gate", ex)
    if c == "publish":
        def pub(st: Steps) -> dict:
            r = publish(cyc, st.cycle_id)
            return finish_ok(cyc, st, r)
        return one_step(cyc, args.cycle, "publish", pub)
    if c == "rollback":
        return rollback(cyc, args.version)
    if c == "adopt":
        if args.force is not None and cyc.cfg.mode != "minio":
            raise GuardError("--force works only in minio mode")

        def go(st: Steps) -> dict:
            t = adopt(cyc, st.cycle_id, Path(args.export_dir), st.log_path)
            st.status("gate", f"Cycle {st.cycle_id}: step gate.")
            g = run_gate(cyc, st.cycle_id, st.log_path, force=args.force, heartbeat=st.heartbeat)
            ex = do_explorer(cyc, st, st.started_at, lift=args.lift_failure)
            st.status("publish", f"Cycle {st.cycle_id}: step publish.")
            return {"version": t["version"], "gate": {"pass": g["pass"], "reasons": g["reasons"]}, "explorer": explorer_summary(ex), "publish": finish_ok(cyc, st, publish(cyc, st.cycle_id))}
        return one_step(cyc, None, "train", go, new_id=True)
    if c == "ab":
        now = cyc.clock()
        with cycle_lock(cyc.cfg.data_dir, None, now):
            sync(cyc)
            tables = cyc.cfg.data_dir / "ab" / "tables"
            run_build(cyc, tables, run_log_path(cyc.cfg.logs_dir, "ab-" + new_cycle_id(now)[:8]), decisions=False)
            save_inputs(cyc, tables / "records.jsonl", None, None)
            return run_ab(cyc, tables / "records.jsonl")
    if c == "run":
        return cmd_run(cyc, args.force)
    if c == "status":
        return cmd_status(cyc)
    if c == "scheduler":
        return cmd_scheduler(cfg, str(args.config), args)
    if c == "bridge":
        return push(cyc, args.state) if args.direction == "push" else pull(cyc, args.state)
    if c in ("human-model", "priors", "flags", "player-types", "open-data"):
        if c == "open-data" and args.upload:
            # The newest export first, so the upload can refuse a package built from an older one.
            now = cyc.clock()
            with cycle_lock(cyc.cfg.data_dir, None, now):
                sync(cyc)
        try:
            cid = cyc.latest_work()
        except CycleError:
            cid = new_cycle_id(cyc.clock())
        return human.command(c, context(cyc, cid), args)
    raise CycleError(f"unknown command {c}")


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        cfg = load_config(args.config)
    except CycleError as e:
        print(json.dumps({"ok": False, "error": str(e), "exitCode": e.exit_code}) if args.json else f"error: {e}", file=sys.stdout if args.json else sys.stderr)
        return e.exit_code
    log = setup_logging(cfg.logs_dir, quiet=False)
    cyc = Cycle(cfg, log)
    try:
        result = dispatch(args, cfg, cyc)
    except CycleError as e:
        log.error(f"{args.cmd}: {e}")
        if args.json:
            print(json.dumps({"ok": False, "command": args.cmd, "error": str(e), "exitCode": e.exit_code}))
        return e.exit_code
    except Exception as e:
        log.exception(f"{args.cmd}: unexpected {type(e).__name__}")
        if args.json:
            print(json.dumps({"ok": False, "command": args.cmd, "error": f"{type(e).__name__}: {e}", "exitCode": 1}))
        return 1
    if args.json:
        print(json.dumps({"ok": True, "command": args.cmd, "result": result}, default=str))
    else:
        print(json.dumps(result, indent=2, default=str))
    return 0
