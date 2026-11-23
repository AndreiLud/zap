"""The explorer step of the gate and its guard (zapcycle/explorer.py): commands, verdicts, the record
of failing explorers, the reuse rule, the card and the publish guard. The Node benches and train.py
are replaced by FakeTools, which writes the result files they write."""

import copy
import json
import struct
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from zapcycle import explorer as X
from zapcycle import formats
from zapcycle.config import ROOT, load_config
from zapcycle.core import read_json, sha256_file, write_json
from zapcycle.errors import CycleError, GuardError
from zapcycle.publish import init, publish
from zapcycle.train import train_command, with_human

from .helpers import CONFIG_DIR, fake_cycle, temp_config
from .samples import make_candidate

ADAPT = {"bmax": 0.2, "nHalf": 1}
T0 = 1_795_500_000_000
CID = "20261128-2200"
CID2 = "20261205-2200"
PICK = "neverRaises>bluffer@3/same"
OUTSIDE = "trapper<>raisesAll@1/same"
SEEDED = "trapper>bluffer@3/v1"


def zapw(path: Path, features="v2", adapt=ADAPT, version="v2", body=b"\x01\x02\x03\x04" * 8, iteration=590) -> Path:
    meta = {"version": version, "iteration": iteration, "priors": {"raise": 0.3}}
    if adapt is not None:
        meta["adapt"] = adapt
    header = json.dumps({"arch": "mlp-v1", "features": features, "inputs": 461, "hidden": [256, 256], "policy": 15, "value": 1, "tensors": [], "meta": meta}).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<III", 0x5750415A, 1, len(header)) + header + b"\0" * ((4 - len(header) % 4) % 4) + body)
    return path


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


class FakeTools:
    """explorer.ts, explorer-trained.ts, explorer_init.py and train.py as far as the cycle reads
    them: each writes the files the real tool writes, with the adaptation part's upper bound of each
    explorer from `upper` (0.005 when not given)."""

    def __init__(self, upper: dict | None = None, pick: str = PICK, outside: str | None = OUTSIDE, iters: int | None = None, stray: bool = False):
        self.upper = upper or {}
        self.pick, self.outside = pick, outside
        self.iters = iters  # iterations the PPO explorer reaches (its --iters when None)
        self.stray = stray  # the measure also leaves a result measured against another file in history/
        self.cmds: list[list[str]] = []

    def part(self, label: str) -> dict:
        u = self.upper.get(label, 0.005)
        return {"mean": round(u - 0.003, 5), "se": 0.002, "ci95": [round(u - 0.007, 5), round(u + 0.001, 5)], "upper95": u, "pairs": 16}

    def __call__(self, cmd, log_path, env=None, deadline=None, heartbeat=None, **kw):
        self.cmds.append(list(cmd))
        arg = lambda n, d=None: cmd[cmd.index(n) + 1] if n in cmd else d  # noqa: E731
        p = lambda s: X._abs(s)  # noqa: E731
        if cmd[1] == X.EXPLORER_TS:
            A = arg("--adaptive")
            sha = sha256_file(p(A))
            if arg("--stage") == "search":
                write_json(p(arg("--out")), {"chosen": X.parse_label(self.pick), "chosenInTraining": self.outside is not None, "bestOutside": {"spec": X.parse_label(self.outside)} if self.outside else None})
                return ""
            spec = read_json(p(arg("--spec")))
            main = X.explorer_label(spec["chosen"])
            o = X.explorer_label(spec["bestOutside"]["spec"]) if spec.get("chosenInTraining") and spec.get("bestOutside") else None
            e = {"split": {"adaptationPart": self.part(main)}, "models": {"adaptive": {"path": A, "sha256": sha}}, "chosen": spec["chosen"], "outsideTraining": {"split": {"adaptationPart": self.part(o)}, "chosen": spec["bestOutside"]["spec"]} if o else None}
            write_json(p(arg("--out")), {"attempt": {"attempt": int(arg("--attempt")), "explorer": main, "outside": {"explorer": o} if o else None}, "facts": {"explorer": e}})
        elif cmd[1] == X.TRAINED_TS:
            A = arg("--adaptive")
            sha = sha256_file(p(A))
            ev = X.run_of(p(A)) / "eval"
            if arg("--stage") == "measure":
                E = arg("--explorer")
                out = p(arg("--out")) if "--out" in cmd else ev / "explorer-trained.json"
                write_json(out, {"facts": {"explorer.trained": {"explorer": E, "fresh": {"adaptationPart": self.part(E)}, "models": {"adaptive": {"path": A, "sha256": sha}}}}})
                if self.stray:
                    write_json(ev / "history" / "stray.json", {"facts": {"explorer.trained": {"explorer": "x/stray.zapw", "fresh": {"adaptationPart": self.part("x/stray.zapw")}, "models": {"adaptive": {"path": "x.zapw", "sha256": "d" * 64}}}}})
            elif arg("--stage") == "control":
                C = arg("--control")
                write_json(ev / "explorer-control.json", {"facts": {"explorer.control": {"explorer": C, "fresh": {"control": {"adaptationPart": self.part(C)}}, "models": {"adaptive": {"path": A, "sha256": sha}}}}})
            else:
                out = ev / "explorer-trained.json"
                r = read_json(out)
                vs = [v for v in X.read_results(X.eval_files(ev)) if v["sha256"] == sha]
                strip = lambda v: {"explorer": v["explorer"], "adaptationPart": v["adaptationPart"]}  # noqa: E731
                by_file: dict[str, list] = {}
                for v in vs:
                    if v["kind"] == "scripted":
                        by_file.setdefault(v["file"], []).append(strip(v))
                main = [v for v in vs if v["kind"] == "trained" and v["file"] == X.rel(out)]
                other = [{**strip(v), "file": v["file"]} for v in vs if v["kind"] == "trained" and v["file"] != X.rel(out)]
                ctl = [v for v in vs if v["kind"] == "control"]
                r["facts"]["explorer.criterion"] = {
                    "servedModel": {"path": A, "sha256": sha, "adapt": ADAPT},
                    "verdicts": {"scripted": [{"file": f, "explorers": e} for f, e in by_file.items()], **({"trained": strip(main[0])} if main else {}), **({"otherTrained": other} if other else {}), **({"control": strip(ctl[0])} if ctl else {})},
                    "pass": all(v["adaptationPart"]["upper95"] <= 0.01 for v in vs),
                    "pendingRemeasure": [],
                    "requirement": 0.01,
                }
                write_json(out, r)
        elif cmd[1] == X.INIT_PY:
            out = p(arg("--out"))
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"actor")
            (out.parent / "start.zapw").write_bytes(b"start")
        elif cmd[1] == "training/train.py":
            run = p(arg("--run"))
            (run / "batches").mkdir(parents=True, exist_ok=True)
            for n in ("current.zapw", "checkpoint.pt"):
                (run / n).write_bytes(b"x")
            write_json(run / "args.json", {"league_fixed": arg("--league-fixed")})
            n = int(arg("--iters")) if self.iters is None else self.iters
            (run / "metrics.jsonl").write_text("".join(json.dumps({"iteration": i, "mode": "ppo", "decisions": 10, "matches": 2}) + "\n" for i in range(n)))
        else:
            raise AssertionError(f"unexpected command {cmd}")
        return ""

    def named(self, tool: str, stage: str | None = None) -> list[list[str]]:
        return [c for c in self.cmds if c[1] == tool and (stage is None or c[c.index("--stage") + 1] == stage)]


def facts_file(tmp: Path, served: Path | None = None, files: dict | None = None) -> Path:
    """A facts.json whose criterion history records SEEDED failing against an earlier file; with
    `served`, its criterion judges that file with the given scripted result files."""
    crit = {
        "measuredAt": "2026-11-23T17:49:30.756Z",
        "requirement": 0.01,
        "history": [{"kind": "scripted", "file": "x/explorer-fresh-2.json", "model": {"path": "x.zapw", "sha256": "4" * 64}, "adapt": {"bmax": 0.5, "nHalf": 1}, "attempt": 2, "explorers": [{"explorer": SEEDED, "pass": False, "adaptationPart": {"mean": 0.0083, "upper95": 0.011, "pairs": 8000}}]}],
        "pendingRemeasure": [],
    }
    if served is not None:
        crit.update(servedModel={"path": str(served), "sha256": sha256_file(served), "adapt": ADAPT}, pass_=True)
        crit["pass"] = crit.pop("pass_")
        crit["verdicts"] = {"scripted": [{"file": str(f), "explorers": [{"explorer": label, "adaptationPart": {"mean": 0.001, "upper95": u, "pairs": 8000}}]} for f, (label, u) in (files or {}).items()]}
    else:
        crit.update(servedModel={"path": str(tmp / "absent.zapw"), "sha256": "7" * 64, "adapt": ADAPT}, verdicts={}, **{"pass": True})
    hist = {"keys": {"explorer": {"measuredAt": "2026-11-23T05:25:48.616Z", "chosen": {"a": "trapper", "b": "bluffer", "k": 3, "trigger": "hand", "partner": "v1"}, "attempts": [{"attempt": 2, "explorer": SEEDED, "adapt": {"bmax": 0.5, "nHalf": 1}, "passAdaptationPart": False, "adaptationPart": {"upper95": 0.011}}]}}}
    out = tmp / "facts.json"
    write_json(out, {"ai": {"adaptation": {"explorer": {"criterion": crit}, "history": {"f" * 64: hist}}}})
    return out


def scripted_result(path: Path, model: Path, label: str, upper: float) -> Path:
    write_json(path, {"attempt": {"attempt": 5, "explorer": label, "outside": None}, "facts": {"explorer": {"split": {"adaptationPart": {"mean": 0.001, "upper95": upper, "pairs": 8000}}, "models": {"adaptive": {"path": str(model), "sha256": sha256_file(model)}}, "chosen": X.parse_label(label)}}})
    return path


class Base(unittest.TestCase):
    profile = "test"

    def setUp(self):
        self.cfg, self.tmp = temp_config(self.profile)
        self.cfg = self.cfg.with_values("gate", stats="live")
        self.clock = Clock()
        self.cyc, self.s3 = fake_cycle(self.cfg, clock=self.clock)
        self.M = self.cfg.storage["models_bucket"]
        self.facts = facts_file(self.tmp)
        self.log = self.tmp / "run.log"

    def candidate(self, cycle_id: str, version: str = "v2", passed: bool = True, reading: bool = True, body: bytes = b"\x01\x02\x03\x04" * 8) -> Path:
        """A cycle's work folder as train and gate leave it (samples.make_candidate), its candidate a
        features v2 file with a safety net when `reading`."""
        work = make_candidate(self.cyc, cycle_id, version, self.cyc.require_manifest()["current"], passed)
        if not reading:
            return work
        train = read_json(work / "train.json")
        f = Path(train["export"]["file"])
        zapw(f, version=version, body=body)
        man = {**train["export"]["manifest"], "features": "v2", "inputs": 461, "adapt": ADAPT, "sha256": sha256_file(f), "bytes": f.stat().st_size}
        write_json(f.parent / "manifest.json", man)
        train["export"]["manifest"] = man
        args = work / "runs" / "candidate" / "args.json"
        write_json(args, {"league_mix": self.cfg.train["league_mix_live"], "feint_hands": "1,8", "feint_evidence": "2,8"})
        train["argsFile"] = str(args)
        write_json(work / "train.json", train)
        g = read_json(work / "gate" / "result.json")
        g["candidate"]["sha256"] = man["sha256"]
        write_json(work / "gate" / "result.json", g)
        return work

    def run_step(self, cycle_id: str, tools: FakeTools | None = None, cyc=None):
        tools = tools or FakeTools()
        with mock.patch("zapcycle.proc.run", tools):
            res = X.run_explorer(cyc or self.cyc, cycle_id, self.log, facts_path=self.facts)
        return res, tools


class FileTest(unittest.TestCase):
    def test_network_hash_leaves_out_the_version_and_other_metadata(self):
        d = Path(tempfile.mkdtemp())
        a = X.network_hash(zapw(d / "a.zapw", version="v2", iteration=590))
        self.assertEqual(a, X.network_hash(zapw(d / "b.zapw", version="v13", iteration=12)))
        self.assertNotEqual(a, X.network_hash(zapw(d / "c.zapw", adapt={"bmax": 0.1, "nHalf": 1})))
        self.assertNotEqual(a, X.network_hash(zapw(d / "d.zapw", body=b"\x01\x02\x03\x05" * 8)))
        self.assertNotEqual(sha256_file(d / "a.zapw"), sha256_file(d / "b.zapw"))

    def test_which_files_can_read(self):
        h = lambda f, a: {"features": f, "meta": {"adapt": a}}  # noqa: E731
        self.assertTrue(X.can_read(h("v2", ADAPT)))
        self.assertFalse(X.can_read(h("v2", None)))
        self.assertFalse(X.can_read(h("v2", {"bmax": float("inf"), "nHalf": 1})))
        self.assertFalse(X.can_read(h("v2-empty", ADAPT)))
        self.assertFalse(X.can_read(h("v1", ADAPT)))

    def test_labels(self):
        for label in ("trapper>bluffer@3/v1", "runsAll>trapper@e4/same", "trapper<>raisesAll@1/same", "rock>bluffer>rock@2,5/same", "rock>runsAll@1/own:bluffer>rock@e2"):
            self.assertEqual(X.explorer_label(X.parse_label(label)), label)
        for bad in ("trapper>bluffer/v1", "trapper>bluffer@3/both", "a<>b>c@1/same"):
            with self.assertRaises(CycleError):
                X.parse_label(bad)

    def test_seeds_follow_the_cycle_id(self):
        self.assertEqual(len(X.seed(CID, "search")), 64)
        self.assertNotEqual(X.seed(CID, "search"), X.seed(CID2, "search"))
        self.assertNotEqual(X.seed(CID, "search"), X.seed(CID, "fresh"))


class ConfigTest(unittest.TestCase):
    def test_prod_has_the_sizes_of_the_feints_run(self):
        x = load_config(CONFIG_DIR / "prod.toml", env={}).explorer
        # _local/m6/run-feints.sh: PAIRS, ROUND_PAIRS, GRID_LIMIT, X_ITERS, X_DECISIONS, X_EVAL_EVERY,
        # X_EVAL_PAIRS, X_HOURS, X_PAIRS, X_CHECK_PAIRS, X_STYLE_MATCHES, THREADS; workers and threads 3.
        self.assertEqual((x["fresh_pairs"], x["round_pairs"], x["grid_limit"], x["pool"]), (2000, 64, 0, "all"))
        self.assertEqual((x["trained_iters"], x["trained_decisions"], x["trained_eval_every"], x["trained_eval_pairs"], x["trained_hours"]), (103, 120000, 10, 200, 3))
        self.assertEqual((x["measure_pairs"], x["check_pairs"], x["style_matches"], x["threads"], x["trained_workers"], x["trained_threads"], x["trained_critic_warmup"]), (2000, 200, 500, 4, 3, 3, 5))
        self.assertEqual((x["limit"], x["seeds"], x["on"]), (0.01, "cycle", True))

    def test_live_league_is_the_feints_league_of_the_network_that_passed(self):
        t = load_config(CONFIG_DIR / "prod.toml", env={}).train
        self.assertGreater(dict(p.split("=") for p in t["league_mix_live"].split(","))["feints"], "0")
        args = ROOT / "training" / "runs" / "m6-adaptive-r" / "args.json"
        if not args.exists():
            self.skipTest("training/runs/m6-adaptive-r is not on this machine")
        a = read_json(args)
        self.assertEqual((t["league_mix_live"], t["feint_hands"], t["feint_evidence"]), (a["league_mix"], a["feint_hands"], a["feint_evidence"]))
        fixed = t["fixed_args"]
        self.assertEqual(fixed[fixed.index("--switch-hands") + 1], a["switch_hands"])

    def _refused(self, old: str, new: str):
        text = (CONFIG_DIR / "prod.toml").read_text()
        self.assertIn(old, text)
        p = Path(tempfile.mkdtemp()) / "bad.toml"
        p.write_text(text.replace(old, new, 1))
        with self.assertRaises(CycleError):
            load_config(p, env={})

    def test_bad_values_are_refused(self):
        self._refused("limit = 0.01", "limit = 0.02")
        self._refused('seeds = "cycle"', 'seeds = "fixed"')
        self._refused("switching=0.04,feints=0.12", "switching=0.16")
        self._refused("trained_hours = 3 ", "trained_hours = 7 ")
        self._refused("[explorer]", "[explorers]")


class LiveLeagueTest(Base):
    def test_train_command_with_the_statistics_live(self):
        init(self.cyc)
        run = self.cfg.work_dir / "c" / "runs" / "candidate"
        cmd = train_command(self.cyc, run, {"features": "v2", "hidden": "256,256"}, "ai/models/opponent-priors.json", self.tmp / "init.pt", "d9", 0.5, [])
        self.assertEqual(cmd[cmd.index("--league-mix") + 1], self.cfg.train["league_mix_live"])
        self.assertEqual((cmd[cmd.index("--feint-hands") + 1], cmd[cmd.index("--feint-evidence") + 1]), ("1,8", "2,8"))
        human = train_command(self.cyc, run, {"features": "v2"}, None, self.tmp / "init.pt", "d9", 0.5, [], None, self.tmp / "h.zapw")
        self.assertEqual(human[human.index("--league-mix") + 1], with_human(self.cfg.train["league_mix_live"], self.cfg.human["model"]["league_share"]))
        self.cyc.cfg = self.cfg.with_values("gate", stats="empty")
        cmd = train_command(self.cyc, run, {"features": "v2"}, None, self.tmp / "init.pt", "d9", 0.5, [])
        self.assertEqual(cmd[cmd.index("--league-mix") + 1], self.cfg.train["league_mix"])
        self.assertNotIn("--feint-hands", cmd)

    def test_step_due_needs_a_reading_file_live_statistics_and_the_step_on(self):
        self.assertTrue(X.step_due(self.cfg, "v2", ADAPT))
        self.assertFalse(X.step_due(self.cfg, "v2", None))
        self.assertFalse(X.step_due(self.cfg, "v2-empty", None))
        self.assertFalse(X.step_due(self.cfg.with_values("gate", stats="empty"), "v2", ADAPT))
        self.assertFalse(X.step_due(self.cfg.with_values("explorer", on=False), "v2", ADAPT))
        self.assertFalse(X.step_due(replace(self.cfg, explorer={}), "v2", ADAPT))


class StepTest(Base):
    def setUp(self):
        super().setUp()
        init(self.cyc)

    def test_the_full_step(self):
        self.candidate(CID)
        res, tools = self.run_step(CID, FakeTools(upper={SEEDED: 0.004}))
        x = self.cfg.explorer
        self.assertEqual((res["ran"], res["source"], res["pass"]), (True, "measured", True), res.get("reasons"))
        labels = [v["explorer"] for v in res["verdicts"]]
        explorer_file = X.rel(X.folder(self.cyc, CID) / "1" / "explorer-run" / "explorer.zapw")
        self.assertEqual(labels, [PICK, OUTSIDE, SEEDED, explorer_file])
        self.assertEqual(res["remeasured"], [SEEDED])
        self.assertEqual(res["failuresOnRecord"], [SEEDED])
        (search,) = tools.named(X.EXPLORER_TS, "search")
        for k, v in (("--pool", "all"), ("--baseline", "ablated"), ("--seed", X.seed(CID, "search")), ("--round-pairs", str(x["round_pairs"])), ("--grid-limit", str(x["grid_limit"]))):
            self.assertEqual(search[search.index(k) + 1], v)
        fresh, remeasure = tools.named(X.EXPLORER_TS, "fresh")
        self.assertNotIn("--remeasure", fresh)
        self.assertEqual((fresh[fresh.index("--attempt") + 1], fresh[fresh.index("--pairs") + 1], fresh[fresh.index("--seed") + 1]), ("1", str(x["fresh_pairs"]), X.seed(CID, "fresh")))
        self.assertIn("--remeasure", remeasure)
        self.assertEqual(remeasure[remeasure.index("--attempt") + 1], "2")
        spec = read_json(X._abs(remeasure[remeasure.index("--spec") + 1]))
        self.assertEqual(spec["chosen"], {"a": "trapper", "b": "bluffer", "k": 3, "trigger": "hand", "partner": "v1"})
        self.assertEqual(spec["provenance"]["models"]["adaptive"]["sha256"], "4" * 64)
        (ppo,) = [c for c in tools.cmds if c[1] == "training/train.py"]
        for k, v in (("--features", "v2-self"), ("--iters", str(x["trained_iters"])), ("--max-hours", f"{x['trained_hours']:.3f}"), ("--seed-base", X.seed(CID, "trained")[:2]), ("--episode", "match"), ("--league-mix", "snapshots=1")):
            self.assertEqual(ppo[ppo.index(k) + 1], v)
        self.assertIn("--league-as-served", ppo)
        self.assertEqual(ppo[ppo.index("--league-fixed") + 1], ppo[ppo.index("--eval-served") + 1])
        self.assertEqual(len(tools.named(X.TRAINED_TS, "measure")), 1)
        self.assertEqual(len(tools.named(X.TRAINED_TS, "facts")), 1)
        # Only what a measure reads again stays.
        xr = X.folder(self.cyc, CID) / "1" / "explorer-run"
        self.assertTrue((xr / "explorer.zapw").exists())
        self.assertFalse((xr / "checkpoint.pt").exists() or (xr / "batches").exists())
        stored = read_json(X.verdicts_dir(self.cyc) / f"{res['candidate']['network']}.json")
        self.assertEqual((stored["pass"], len(stored["verdicts"])), (True, 4))
        self.assertEqual(self.cyc.state["explorerVerdicts"][-1]["pass"], True)
        self.assertEqual(read_json(self.cyc.work(CID) / "gate" / "explorer.json")["pass"], True)
        self.assertTrue(set(res["seconds"]) >= {"search", "fresh", "remeasure", "trainedTraining", "trainedMeasure", "criterion", "total"})
        self.assertEqual((res["ppo"]["iterations"], res["ppo"]["wanted"], res["attempt"]), (x["trained_iters"], x["trained_iters"], 1))
        self.assertEqual(res["settings"], X.settings(self.cyc))
        # Every explorer measured joins the record of measured explorers, with what measures it again.
        rec = {e["explorer"]: e for e in self.cyc.state["explorerMeasured"]}
        self.assertEqual(sorted(rec), sorted(labels))
        self.assertEqual(rec[explorer_file]["files"]["run"], X.rel(xr))
        self.assertEqual(rec[PICK]["spec"], X.parse_label(PICK))

    def test_a_failing_explorer_rejects_and_joins_the_record(self):
        self.candidate(CID)
        explorer_file = X.rel(X.folder(self.cyc, CID) / "1" / "explorer-run" / "explorer.zapw")
        res, _ = self.run_step(CID, FakeTools(upper={PICK: 0.0125, explorer_file: 0.02}))
        self.assertFalse(res["pass"])
        self.assertEqual(res["newFailures"], [PICK, explorer_file])
        self.assertTrue(any(r.startswith(PICK) and "1.25" in r and "above the limit of 1.00" in r for r in res["reasons"]), res["reasons"])
        rec = {e["explorer"]: e for e in self.cyc.state["explorerFailures"]}
        self.assertEqual(rec[PICK]["spec"], X.parse_label(PICK))
        self.assertEqual(rec[explorer_file]["kind"], "trained")
        self.assertEqual(rec[explorer_file]["files"]["explorer"], explorer_file)
        self.assertFalse((X.verdicts_dir(self.cyc) / f"{res['candidate']['network']}.json").exists())
        # S2: the step again in the same cycle keeps what that cycle recorded and measures nothing:
        # a failure against the exact network is final.
        res2, tools = self.run_step(CID, FakeTools())
        self.assertEqual((res2["ran"], res2["pass"], tools.cmds), (False, False, []))
        self.assertIn(f"failed the explorer test in cycle {CID}", res2["reasons"][0])
        self.assertEqual([e["explorer"] for e in self.cyc.state["explorerFailures"]], [SEEDED, PICK, explorer_file])
        self.assertTrue((X._abs(explorer_file)).exists())

    def test_the_next_candidate_measures_every_recorded_explorer_again(self):
        self.candidate(CID)
        explorer_file = X.rel(X.folder(self.cyc, CID) / "1" / "explorer-run" / "explorer.zapw")
        self.run_step(CID, FakeTools(upper={PICK: 0.03, explorer_file: 0.02}))
        self.candidate(CID2, "v3", body=b"\x09" * 32)
        res, tools = self.run_step(CID2)
        self.assertEqual(res["source"], "measured")
        # The failures and the explorers that passed (OUTSIDE) alike, as run-feints.sh did.
        self.assertEqual(sorted(res["remeasured"]), sorted([SEEDED, PICK, OUTSIDE, explorer_file]))
        self.assertEqual(res["measuredOnRecord"], [OUTSIDE])
        (old,) = [c for c in tools.named(X.TRAINED_TS, "measure") if "--out" in c]
        self.assertEqual(old[old.index("--explorer") + 1], explorer_file)
        self.assertEqual(old[old.index("--trained-against") + 1], X.rel(X.folder(self.cyc, CID) / "1" / "export" / "zap-v2.zapw"))
        self.assertTrue(res["pass"], res.get("reasons"))

    def test_not_run_when_blocked(self):
        self.candidate(CID)
        for cfg, why in ((self.cfg.with_values("gate", stats="empty"), "stats"), (self.cfg.with_values("explorer", on=False), "turns the explorer step off"), (replace(self.cfg, explorer={}), "turns the explorer step off")):
            self.cyc.cfg = cfg
            res, tools = self.run_step(CID)
            self.assertEqual((res["ran"], res["pass"], tools.cmds), (False, False, []))
            self.assertIn(why, res["reasons"][0])
            self.assertEqual([(r["cycleId"], r["source"], r["pass"]) for r in self.cyc.state["explorerVerdicts"]], [(CID, "none", False)])
        self.cyc.cfg = self.cfg
        work = self.cyc.work(CID)
        g = read_json(work / "gate" / "result.json")
        write_json(work / "gate" / "result.json", {**g, "pass": False})
        res, tools = self.run_step(CID)
        self.assertEqual((res["ran"], res["reasons"]), (False, ["Not run: the gate rejected the candidate."]))
        write_json(work / "gate" / "forced.json", {"force": "pass", "measuredPass": False})
        res, tools = self.run_step(CID)
        self.assertTrue(res["ran"])

    def test_a_file_that_cannot_read_has_no_step(self):
        self.candidate(CID, reading=False)
        res, tools = self.run_step(CID)
        self.assertIsNone(res)
        self.assertEqual(tools.cmds, [])


class ReuseTest(Base):
    def setUp(self):
        super().setUp()
        init(self.cyc)

    def test_a_passing_verdict_for_the_same_network_is_reused(self):
        self.candidate(CID, "v2")
        first, _ = self.run_step(CID)
        self.assertTrue(first["pass"])
        # The same network exported again as v3: another SHA-256, the same network hash.
        self.clock.t += 1000
        X.record_failure(self.cyc.state, "scripted", "rock>runsAll@1/same", {"sha256": "c" * 64, "network": None, "adapt": ADAPT, "upper95": 0.02, "at": self.clock.t, "source": "test"}, X.parse_label("rock>runsAll@1/same"))
        self.cyc.state.save()
        self.clock.t += 1000
        work = self.candidate(CID2, "v3")
        cand = Path(read_json(work / "train.json")["export"]["file"])
        self.assertNotEqual(sha256_file(cand), first["candidate"]["sha256"])
        self.assertEqual(X.network_hash(cand), first["candidate"]["network"])
        res, tools = self.run_step(CID2)
        self.assertEqual((res["source"], res["pass"]), ("reused", True), res.get("reasons"))
        self.assertEqual(res["reusedFrom"]["cycleId"], CID)
        # No search, no training: only the explorer recorded after that verdict is measured again
        # (SEEDED was measured by the reused verdict and recorded before it).
        self.assertEqual([c[c.index("--stage") + 1] for c in tools.cmds], ["fresh"])
        self.assertEqual(res["remeasured"], ["rock>runsAll@1/same"])
        self.assertEqual(sum(v["reused"] for v in res["verdicts"]), len(first["verdicts"]))
        self.assertEqual(len(res["verdicts"]), len(first["verdicts"]) + 1)

    def test_a_reused_verdict_still_fails_on_a_new_failure(self):
        self.candidate(CID, "v2")
        self.run_step(CID)
        self.clock.t += 1000
        X.record_failure(self.cyc.state, "scripted", "rock>runsAll@1/same", {"sha256": "c" * 64, "network": None, "adapt": ADAPT, "upper95": 0.02, "at": self.clock.t, "source": "test"}, X.parse_label("rock>runsAll@1/same"))
        self.candidate(CID2, "v3")
        res, _ = self.run_step(CID2, FakeTools(upper={"rock>runsAll@1/same": 0.015}))
        self.assertEqual((res["source"], res["pass"]), ("reused", False))
        self.assertEqual(res["newFailures"], ["rock>runsAll@1/same"])

    def test_a_verdict_with_a_missing_file_is_not_reused(self):
        self.candidate(CID, "v2")
        first, _ = self.run_step(CID)
        Path(X._abs(first["verdicts"][0]["file"])).unlink()
        self.candidate(CID2, "v3")
        res, tools = self.run_step(CID2)
        self.assertEqual(res["source"], "measured")
        self.assertTrue(any("missing on this machine" in n for n in res["notes"]), res["notes"])

    def test_the_verdict_of_facts_json_is_reused_when_its_files_are_there(self):
        d = self.tmp / "runs" / "m6-adaptive-r"
        served = zapw(d / "export" / "zap-v2-b0.2-h1.zapw", version="v2")
        files = {scripted_result(d / "eval" / f"explorer-fresh-{n}.json", served, label, u): (label, u) for n, (label, u) in enumerate(((PICK, 0.00773), (SEEDED, 0.00501)), 5)}
        self.facts = facts_file(self.tmp, served, files)
        fv = X.facts_verdict(self.facts)
        self.assertEqual((fv["pass"], len(fv["verdicts"]), fv["network"]), (True, 2, X.network_hash(served)))
        self.candidate(CID, "v3")  # the same network, numbered v3 by an adoption
        res, tools = self.run_step(CID)
        self.assertEqual((res["source"], res["pass"], res["reusedFrom"]["source"]), ("reused", True, X.FACTS_SOURCE), res.get("reasons"))
        self.assertEqual(tools.cmds, [])  # SEEDED failed before that verdict and was measured by it
        # One result file gone: the same adoption runs the whole step.
        next(iter(files)).unlink()
        self.assertTrue(X.facts_verdict(self.facts)["problems"])
        res, tools = self.run_step(CID)
        self.assertEqual(res["source"], "measured")


class GuardTest(Base):
    def setUp(self):
        super().setUp()
        init(self.cyc)

    def card(self, v: str) -> dict:
        return json.loads(self.s3.buckets[self.M][f"cards/{v}.json"]["body"])

    def assert_refused(self, version: str, words: str):
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, CID)
        self.assertIn(words, str(e.exception))
        card = self.card(version)
        formats.check("zap-card/1", card)
        self.assertEqual(card["result"], "rejected")
        self.assertIn("Refused by the explorer guard", card["reason"])
        self.assertFalse(card["explorer"]["pass"])
        self.assertEqual(self.cyc.require_manifest()["current"], "v1")
        return card

    def test_no_step_no_promotion(self):
        self.candidate(CID)
        self.assert_refused("v2", "the explorer step left no result")

    def test_a_config_that_turns_the_step_off(self):
        self.candidate(CID)
        self.cyc.cfg = self.cfg.with_values("explorer", on=False)
        self.run_step(CID)
        card = self.assert_refused("v2", "turns the explorer step off")
        self.assertEqual((card["explorer"]["source"], card["explorer"]["verdicts"]), ("none", []))

    def test_statistics_live_without_the_explorer_section(self):
        self.candidate(CID)
        self.cyc.cfg = replace(self.cfg, explorer={})
        self.run_step(CID)
        self.assert_refused("v2", "turns the explorer step off")

    def test_statistics_empty(self):
        self.candidate(CID)
        self.cyc.cfg = self.cfg.with_values("gate", stats="empty")
        self.run_step(CID)
        self.assert_refused("v2", "stats is not")

    def test_a_forced_pass_does_not_skip_the_guard(self):
        work = self.candidate(CID, passed=False)
        write_json(work / "gate" / "forced.json", {"force": "pass", "measuredPass": False})
        self.assert_refused("v2", "the explorer step left no result")

    def test_a_passing_step_promotes(self):
        self.candidate(CID)
        self.run_step(CID)
        r = publish(self.cyc, CID)
        self.assertEqual(r["result"], "promoted")
        card = self.card("v2")
        formats.check("zap-card/1", card)
        self.assertTrue(card["explorer"]["pass"])
        self.assertEqual(card["explorer"]["failuresOnRecord"], [SEEDED])
        self.assertTrue(card["reason"].startswith("Passed the explorer test: 4 verdicts"), card["reason"])

    def test_a_measured_failure_is_a_rejection_with_every_verdict(self):
        self.candidate(CID)
        self.run_step(CID, FakeTools(upper={OUTSIDE: 0.011}))
        r = publish(self.cyc, CID)
        self.assertEqual(r["result"], "rejected")
        card = self.card("v2")
        formats.check("zap-card/1", card)
        self.assertEqual(len(card["explorer"]["verdicts"]), 4)
        self.assertEqual([v["pass"] for v in card["explorer"]["verdicts"]], [True, False, True, True])
        self.assertTrue(card["reason"].startswith("Passed the gate. Not promoted by the explorer test: trapper<>raisesAll@1/same"), card["reason"])

    def test_a_result_file_changed_after_the_step(self):
        self.candidate(CID)
        res, _ = self.run_step(CID)
        f = X._abs(res["verdicts"][0]["file"])
        r = read_json(f)
        r["facts"]["explorer"]["split"]["adaptationPart"]["upper95"] = 0.05
        write_json(f, r)
        self.assert_refused("v2", "above the limit")

    def test_a_failure_recorded_after_the_step(self):
        self.candidate(CID)
        self.run_step(CID)
        X.record_failure(self.cyc.state, "scripted", "rock>runsAll@1/same", {"sha256": "c" * 64, "network": None, "adapt": ADAPT, "upper95": 0.02, "at": T0 + 5, "source": "test"})
        self.assert_refused("v2", "rock>runsAll@1/same")

    def test_a_file_that_cannot_read_is_not_concerned(self):
        self.candidate(CID, reading=False)
        self.assertEqual(publish(self.cyc, CID)["result"], "promoted")
        self.assertNotIn("explorer", self.card("v2"))


class CardFormatTest(Base):
    def setUp(self):
        super().setUp()
        init(self.cyc)
        self.candidate(CID)
        self.run_step(CID)
        publish(self.cyc, CID)
        self.good = json.loads(self.s3.buckets[self.M]["cards/v2.json"]["body"])

    def bad(self, change, words: str):
        c = copy.deepcopy(self.good)
        change(c["explorer"])
        errors = formats.validate("zap-card/1", c)
        self.assertTrue(any(words in e for e in errors), errors)

    def test_rules(self):
        self.assertEqual(formats.validate("zap-card/1", self.good), [])
        self.bad(lambda x: x.update(limit=0.02), "out of range")
        self.bad(lambda x: x["verdicts"][0].update(upper95=0.02), "exactly when upper95")
        self.bad(lambda x: x.update(pending=["somebody>else@1/same"]), "is not on record")
        self.bad(lambda x: x.update(extra=1), "unexpected field extra")
        self.bad(lambda x: x.update(source="reused"), "present exactly when source is reused")
        self.bad(lambda x: x.update(reasons=["why"]), "a passing test ran")

        def failing(x):
            x["verdicts"][0].update(upper95=0.02, **{"pass": False})
            x.update(reasons=["x"], **{"pass": False})

        self.bad(failing, "a promoted card's explorer test passes")
        c = copy.deepcopy(self.good)
        failing(c["explorer"])
        c["result"] = "rejected"
        self.assertEqual(formats.validate("zap-card/1", c), [])


class RecordTest(Base):
    """The record only grows, a failure against the exact network is final, and every explorer on
    record is measured again (scenarios S1 to S5 of the milestone 10 review)."""

    def setUp(self):
        super().setUp()
        init(self.cyc)

    def test_s1_a_blocked_rerun_keeps_the_cycle_failures(self):
        self.candidate(CID)
        res, _ = self.run_step(CID, FakeTools(upper={PICK: 0.03}))
        self.assertIn(PICK, res["newFailures"])
        self.cyc.cfg = self.cfg.with_values("gate", stats="empty")
        res_blocked, tools = self.run_step(CID)
        self.assertEqual((res_blocked["ran"], tools.cmds), (False, []))
        self.cyc.cfg = self.cfg
        self.assertIn(PICK, [e["explorer"] for e in self.cyc.state["explorerFailures"]])
        self.candidate(CID2, "v3", body=b"\x09" * 32)
        res2, _ = self.run_step(CID2)
        self.assertIn(PICK, res2["failuresOnRecord"])
        self.assertIn(PICK, res2["remeasured"])

    def test_s1_a_crash_keeps_what_the_attempt_measured(self):
        self.candidate(CID)

        class Crash(FakeTools):
            def __call__(self, cmd, *a, **kw):
                if cmd[1] == "training/train.py":
                    raise CycleError("time limit")
                return super().__call__(cmd, *a, **kw)

        with self.assertRaises(CycleError):
            self.run_step(CID, Crash(upper={PICK: 0.03}))
        res = read_json(self.cyc.work(CID) / "gate" / "explorer.json")
        self.assertEqual((res["pass"], res["newFailures"]), (False, [PICK]))
        self.assertIn("stopped before its end", res["reasons"][0])
        # A second attempt of the same cycle goes to its own folder; the first keeps its files.
        res2, tools = self.run_step(CID)
        self.assertEqual((res2["ran"], tools.cmds), (False, []))
        self.assertTrue((X.folder(self.cyc, CID) / "1" / "eval" / "explorer-fresh-1.json").exists())

    def test_s2_a_rerun_after_a_failure_cannot_promote(self):
        self.candidate(CID)
        explorer_file = X.rel(X.folder(self.cyc, CID) / "1" / "explorer-run" / "explorer.zapw")
        res, _ = self.run_step(CID, FakeTools(upper={explorer_file: 0.03}))
        self.assertFalse(res["pass"])
        res2, tools = self.run_step(CID, FakeTools())
        self.assertEqual((res2["ran"], tools.cmds), (False, []))
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, CID)
        self.assertIn("failed the explorer test", str(e.exception))
        self.assertEqual(self.cyc.require_manifest()["current"], "v1")

    def test_s4_an_explorer_that_passed_against_an_earlier_file_is_measured_again(self):
        self.candidate(CID)
        res, _ = self.run_step(CID, FakeTools(upper={PICK: 0.0095}))
        self.assertTrue(res["pass"])
        self.candidate(CID2, "v3", body=b"\x09" * 32)
        res2, _ = self.run_step(CID2, FakeTools(pick="rock>runsAll@1/same", outside=None))
        labels = [v["explorer"] for v in res2["verdicts"]]
        self.assertIn(PICK, labels)
        self.assertIn(X.rel(X.folder(self.cyc, CID) / "1" / "explorer-run" / "explorer.zapw"), labels)
        self.assertIn(PICK, res2["measuredOnRecord"])

    def test_s5_the_same_network_failed_in_an_earlier_cycle(self):
        self.candidate(CID, "v2")
        res, _ = self.run_step(CID, FakeTools(upper={PICK: 0.0105}))
        self.assertFalse(res["pass"])
        self.candidate(CID2, "v3")  # the same network again, as an adoption would number it
        res2, tools = self.run_step(CID2, FakeTools(upper={PICK: 0.0095}))
        self.assertEqual(res2["candidate"]["network"], res["candidate"]["network"])
        self.assertEqual((res2["ran"], res2["pass"], tools.cmds), (False, False, []))
        self.assertIn(f"cycle {CID}", res2["reasons"][0])
        with self.assertRaises(GuardError):
            publish(self.cyc, CID2)
        card = json.loads(self.s3.buckets[self.M]["cards/v3.json"]["body"])
        self.assertIn("failed the explorer test", card["reason"])

    def test_the_owner_lifts_a_final_failure_on_the_card(self):
        self.candidate(CID, "v2")
        self.run_step(CID, FakeTools(upper={PICK: 0.0105}))
        self.candidate(CID2, "v3")
        with mock.patch("zapcycle.proc.run", FakeTools(upper={PICK: 0.004})) as tools:
            res = X.run_explorer(self.cyc, CID2, self.log, facts_path=self.facts, lift="The earlier failure came from a wrong twin, checked by hand.")
        self.assertEqual((res["ran"], res["source"], res["pass"]), (True, "measured", True), res.get("reasons"))
        self.assertTrue(tools.named(X.EXPLORER_TS, "search"))  # measured in full, nothing reused
        self.assertEqual(res["lifted"]["failedIn"], [f"cycle {CID}"])
        self.assertEqual(publish(self.cyc, CID2)["result"], "promoted")
        card = json.loads(self.s3.buckets[self.M]["cards/v3.json"]["body"])
        formats.check("zap-card/1", card)
        self.assertEqual(card["explorer"]["lifted"]["reason"], "The earlier failure came from a wrong twin, checked by hand.")
        self.assertIn("The owner lifted the earlier failure", card["reason"])

    def test_the_guard_refuses_a_network_that_failed_after_its_step(self):
        self.candidate(CID)
        res, _ = self.run_step(CID)
        self.assertTrue(res["pass"])
        X.record_failure(self.cyc.state, "scripted", PICK, {"sha256": "c" * 64, "network": res["candidate"]["network"], "adapt": ADAPT, "upper95": 0.012, "at": T0 + 5, "source": "cycle 20261121-2200"}, X.parse_label(PICK))
        self.cyc.state.save()
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, CID)
        self.assertIn("failed the explorer test in cycle 20261121-2200", str(e.exception))

    def test_a_lift_without_a_failure_lifts_nothing(self):
        self.candidate(CID)
        with mock.patch("zapcycle.proc.run", FakeTools()):
            res = X.run_explorer(self.cyc, CID, self.log, facts_path=self.facts, lift="just in case")
        self.assertIsNone(res["lifted"])
        self.assertTrue(any("nothing to lift" in n for n in res["notes"]))

    def test_a_failure_recorded_with_the_same_file_counts_without_a_network(self):
        work = self.candidate(CID)
        sha = sha256_file(Path(read_json(work / "train.json")["export"]["file"]))
        X.record_failure(self.cyc.state, "scripted", "rock>runsAll@1/same", {"sha256": sha, "network": None, "adapt": ADAPT, "upper95": 0.02, "at": T0, "source": "test"}, X.parse_label("rock>runsAll@1/same"))
        res, tools = self.run_step(CID)
        self.assertEqual((res["ran"], tools.cmds), (False, []))


class SizesTest(Base):
    """S3: the sizes and the PPO explorer's iterations a step ran with are on its card and checked."""

    def setUp(self):
        super().setUp()
        init(self.cyc)

    def test_prod_refuses_sizes_below_the_run_that_passed(self):
        for old, new in (("trained_iters = 103", "trained_iters = 1"), ("grid_limit = 0 ", "grid_limit = 1 "), ("round_pairs = 64", "round_pairs = 1"), ('pool = "all"', 'pool = "grid"'), ("fresh_pairs = 2000", "fresh_pairs = 200"), ("measure_pairs = 2000", "measure_pairs = 200"), ("trained_decisions = 120000", "trained_decisions = 1000")):
            ConfigTest._refused(self, old, new)

    def test_the_guard_checks_the_sizes_in_prod(self):
        self.candidate(CID)
        self.run_step(CID)
        self.cyc.cfg = replace(self.cfg, profile="prod")
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, CID)
        self.assertIn("smaller sizes than the run that passed", str(e.exception))
        card = json.loads(self.s3.buckets[self.M]["cards/v2.json"]["body"])
        self.assertEqual(card["explorer"]["settings"]["trained_iters"], self.cfg.explorer["trained_iters"])

    def test_a_short_ppo_explorer_does_not_pass(self):
        self.candidate(CID)
        res, _ = self.run_step(CID, FakeTools(iters=1))
        self.assertFalse(res["pass"])
        self.assertTrue(any("reached 1 of its 2 iterations" in r for r in res["reasons"]), res["reasons"])
        self.assertFalse((X.verdicts_dir(self.cyc) / f"{res['candidate']['network']}.json").exists())
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, CID)
        self.assertIn("reached 1 of its 2 iterations", str(e.exception))
        card = json.loads(self.s3.buckets[self.M]["cards/v2.json"]["body"])
        self.assertEqual(card["explorer"]["ppo"], {"iterations": 1, "wanted": 2})

    def test_a_metrics_file_cut_after_the_step(self):
        self.candidate(CID)
        res, _ = self.run_step(CID)
        (X._abs(res["ppo"]["run"]) / "metrics.jsonl").write_text('{"iteration": 0}\n')
        with self.assertRaises(GuardError):
            publish(self.cyc, CID)

    def test_no_room_for_the_whole_cap_fails_the_step(self):
        self.candidate(CID)
        tools = FakeTools(upper={PICK: 0.03})
        with mock.patch("zapcycle.proc.run", tools), self.assertRaises(CycleError) as e:
            X.run_explorer(self.cyc, CID, self.log, deadline=time.time() + 0.6 * 3600, facts_path=self.facts)
        self.assertIn("rather than train a shorter explorer", str(e.exception))
        self.assertEqual([c for c in tools.cmds if c[1] == "training/train.py"], [])
        # What it measured before stopping stays on record.
        self.assertIn(PICK, [x["explorer"] for x in self.cyc.state["explorerFailures"]])


class FactsRecordTest(Base):
    """The record starts with every verdict of facts.json's criterion, the trained explorers and the
    control with their files, and the step measures them all again, the control included."""

    def setUp(self):
        super().setUp()
        init(self.cyc)
        d = self.tmp / "runs"
        self.served = zapw(d / "m6-adaptive-r" / "export" / "zap-v2-b0.2-h1.zapw", version="v2", body=b"\x05" * 32)
        ev = d / "m6-adaptive-r" / "eval"
        f5 = scripted_result(ev / "explorer-fresh-5.json", self.served, PICK, 0.00773)
        start = d / "m6-explorer-init" / "start.zapw"
        start.parent.mkdir(parents=True)
        start.write_bytes(b"start")
        self.trained, self.other, self.control = (str(d / n / "explorer.zapw") for n in ("m6-explorer-r", "m6-explorer", "m6-explorer-twin"))
        for f in (self.trained, self.other, self.control):
            Path(f).parent.mkdir(parents=True)
            Path(f).write_bytes(b"explorer")
        old_against = zapw(d / "m6-adaptive" / "export" / "zap-v2-b0.5-h1.zapw", adapt={"bmax": 0.5, "nHalf": 1})
        part = lambda u: {"mean": u - 0.004, "upper95": u, "pairs": 8000}  # noqa: E731
        sha = sha256_file(self.served)
        trained_value = {"explorer": self.trained, "start": str(start), "training": {"run": str(Path(self.trained).parent), "against": {"path": str(self.served), "sha256": sha}}, "fresh": {"adaptationPart": part(-0.0057)}, "models": {"adaptive": {"path": str(self.served), "sha256": sha}}}
        write_json(ev / "explorer-trained.json", {"facts": {"explorer.trained": trained_value}})
        other_file = ev / "history" / "old-m6-explorer-b0.2-h1.json"
        write_json(other_file, {"facts": {"explorer.trained": {**trained_value, "explorer": self.other, "training": {"run": str(Path(self.other).parent), "against": {"path": str(old_against)}}, "fresh": {"adaptationPart": part(-0.002)}}}})
        control_value = {"explorer": self.control, "training": {"run": str(Path(self.control).parent)}, "fresh": {"control": {"adaptationPart": part(-0.0045)}}, "models": {"adaptive": {"path": str(self.served), "sha256": sha}}}
        write_json(ev / "explorer-control.json", {"facts": {"explorer.control": control_value}})
        self.facts = facts_file(self.tmp, self.served, {f5: (PICK, 0.00773)})
        facts = read_json(self.facts)
        crit = facts["ai"]["adaptation"]["explorer"]["criterion"]
        crit["verdicts"].update(trained={"explorer": self.trained, "adaptationPart": part(-0.0057)}, otherTrained=[{"file": str(other_file), "explorer": self.other, "trainedAgainst": {"path": str(old_against)}, "adaptationPart": part(-0.002)}], control={"explorer": self.control, "adaptationPart": part(-0.0045)})
        facts["ai"]["adaptation"]["explorer"].update(trained=trained_value, control=control_value)
        write_json(self.facts, facts)

    def test_every_verdict_of_the_criterion_is_on_record(self):
        rows = {m["explorer"]: m for m in X.facts_measured(self.facts)}
        self.assertEqual(sorted(rows), sorted([PICK, self.trained, self.other, self.control]))
        self.assertEqual(rows[PICK]["spec"], X.parse_label(PICK))
        self.assertEqual(rows[self.trained]["files"]["against"], str(self.served))
        self.assertTrue(rows[self.other]["files"]["against"].endswith("zap-v2-b0.5-h1.zapw"))
        self.assertEqual(rows[self.control]["files"], {"explorer": self.control, "run": str(Path(self.control).parent)})
        fv = X.facts_verdict(self.facts)
        self.assertEqual((fv["pass"], len(fv["verdicts"])), (True, 4))

    def test_a_new_network_measures_all_of_them_and_the_control(self):
        self.candidate(CID, "v3", body=b"\x09" * 32)
        res, tools = self.run_step(CID)
        self.assertEqual((res["source"], res["pass"]), ("measured", True), res.get("reasons"))
        for label in (PICK, SEEDED, self.trained, self.other, self.control):
            self.assertIn(label, res["remeasured"])
        (ctl,) = tools.named(X.TRAINED_TS, "control")
        explorer_file = X.rel(X.folder(self.cyc, CID) / "1" / "explorer-run" / "explorer.zapw")
        self.assertEqual((ctl[ctl.index("--control") + 1], ctl[ctl.index("--explorer") + 1], ctl[ctl.index("--seed") + 1]), (self.control, explorer_file, X.seed(CID, "control")))
        kinds = sorted(v["kind"] for v in res["verdicts"])
        self.assertEqual(kinds.count("control"), 1)
        self.assertEqual(kinds.count("trained"), 3)

    def test_the_same_network_reuses_the_criterion(self):
        work = self.candidate(CID, "v3", body=b"\x05" * 32)
        self.assertEqual(X.network_hash(Path(read_json(work / "train.json")["export"]["file"])), X.network_hash(self.served))
        res, tools = self.run_step(CID)
        self.assertEqual((res["source"], res["pass"]), ("reused", True), res.get("reasons"))
        # Only SEEDED, on record and never measured by that criterion, is measured again.
        self.assertEqual((res["remeasured"], [c[c.index("--stage") + 1] for c in tools.cmds]), ([SEEDED], ["fresh"]))

    def test_a_criterion_with_explorers_left_to_measure_is_not_reused(self):
        facts = read_json(self.facts)
        facts["ai"]["adaptation"]["explorer"]["criterion"]["pendingRemeasure"] = ["rock>runsAll@1/same"]
        write_json(self.facts, facts)
        self.assertFalse(X.facts_verdict(self.facts)["pass"])
        self.candidate(CID, "v3", body=b"\x05" * 32)
        res, _ = self.run_step(CID)
        self.assertEqual(res["source"], "measured")


class GuardGapsTest(Base):
    """Mutations of the milestone 10 review that the earlier tests let pass (M6, M7, M9, M10, M11, M13 in
    FactsRecordTest, M15)."""

    def setUp(self):
        super().setUp()
        init(self.cyc)

    def edit_result(self, change):
        p = self.cyc.work(CID2 if (self.cyc.work(CID2) / "gate" / "explorer.json").exists() else CID) / "gate" / "explorer.json"
        r = read_json(p)
        change(r)
        write_json(p, r)

    def test_m6_a_result_for_another_file(self):
        self.candidate(CID)
        self.run_step(CID)
        self.edit_result(lambda r: r["candidate"].update(sha256="d" * 64))
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, CID)
        self.assertIn("names another file", str(e.exception))

    def test_m7_an_explorer_on_record_that_cannot_be_measured(self):
        self.candidate(CID)
        X.record_failure(self.cyc.state, "scripted", "rock>bluffer@2/same", {"sha256": "c" * 64, "network": None, "adapt": ADAPT, "upper95": 0.02, "at": T0, "source": "test"})
        X.record_measured(self.cyc.state, "trained", "x/gone.zapw", {"sha256": "c" * 64, "network": None, "adapt": ADAPT, "upper95": 0.0, "at": T0, "source": "test"})
        self.cyc.state.save()
        res, _ = self.run_step(CID)
        self.assertFalse(res["pass"])
        self.assertEqual(sorted(res["pending"]), ["rock>bluffer@2/same", "x/gone.zapw"])
        self.assertTrue(any("without an explorer spec" in r for r in res["reasons"]), res["reasons"])

    def test_m9_a_failure_after_the_reused_verdict_of_an_explorer_it_measured(self):
        self.candidate(CID, "v2")
        first, _ = self.run_step(CID)
        self.clock.t += 1000
        X.record_failure(self.cyc.state, "scripted", PICK, {"sha256": "c" * 64, "network": None, "adapt": ADAPT, "upper95": 0.02, "at": self.clock.t, "source": "test"}, X.parse_label(PICK))
        self.cyc.state.save()
        self.candidate(CID2, "v3")
        res, tools = self.run_step(CID2)
        self.assertEqual((res["source"], res["remeasured"]), ("reused", [PICK]))
        self.assertEqual([c[c.index("--stage") + 1] for c in tools.cmds], ["fresh"])

    def test_m10_a_reused_verdict_whose_model_holds_another_network(self):
        self.candidate(CID, "v2")
        self.run_step(CID)
        self.candidate(CID2, "v3")
        self.run_step(CID2)
        other = zapw(self.tmp / "other" / "zap-v9.zapw", body=b"\x07" * 32)
        self.edit_result(lambda r: r["reusedFrom"]["models"][0].update(path=str(other), sha256=sha256_file(other)))
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, CID2)
        self.assertIn("is not this network", str(e.exception))

    def test_m11_a_pass_without_verdicts(self):
        self.candidate(CID)
        self.run_step(CID)
        self.cyc.state["explorerFailures"], self.cyc.state["explorerMeasured"] = [], []
        self.cyc.state.save()
        self.edit_result(lambda r: r.update(verdicts=[]))
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, CID)
        self.assertIn("no explorer was measured against this network", str(e.exception))

    def test_m15_results_against_another_file_do_not_count(self):
        self.candidate(CID)
        res, _ = self.run_step(CID, FakeTools(stray=True))
        self.assertTrue(res["pass"], res.get("reasons"))
        self.assertNotIn("x/stray.zapw", [v["explorer"] for v in res["verdicts"]])


class TrainConfigTest(Base):
    """A version in play that can read, with the step unable to run: the cycle stops before training."""

    def test_the_cycle_stops_before_training(self):
        from zapcycle.train import run_train

        init(self.cyc)
        vdir = self.tmp / "versions" / "v3"
        zapw(vdir / "model.zapw", version="v3")
        man = {"current": "v3", "models": {"v3": {"adapt": ADAPT, "sha256": sha256_file(vdir / "model.zapw")}}}
        for cfg, words in ((self.cfg.with_values("gate", stats="empty"), 'stats = "empty"'), (self.cfg.with_values("explorer", on=False), "on = False")):
            self.cyc.cfg = cfg
            with mock.patch.object(self.cyc, "require_manifest", return_value=man), mock.patch.object(self.cyc, "ensure_version", return_value=vdir), mock.patch("zapcycle.proc.run") as run:
                with self.assertRaises(CycleError) as e:
                    run_train(self.cyc, CID, None, T0, self.log)
            self.assertIn("config mismatch", str(e.exception))
            self.assertIn(words, str(e.exception))
            run.assert_not_called()
        self.assertIsNone(X.config_mismatch(self.cfg, "v3", "v2", ADAPT))
        self.assertIsNone(X.config_mismatch(self.cfg.with_values("gate", stats="empty"), "v2", "v2-empty", None))
