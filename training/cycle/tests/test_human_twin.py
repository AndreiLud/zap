"""The twin without human data: the same start, seed, compute and league files as the candidate, the
plain league mix (the candidate also meets the human model as the kind 'human'), the seed floor run
with the seed base plus 1, and int8 files for the comparison. Training itself is replaced by a
stand-in that writes what train.py would."""

import json
import shutil
import struct
import unittest
from pathlib import Path
from unittest import mock

from zapcycle import formats, proc
from zapcycle.config import ROOT
from zapcycle.context import HumanResult
from zapcycle.core import rel, sha256_file
from zapcycle.human import twin
from zapcycle.train import bump_seed, run_train, seed_base, with_human

from .helpers import fake_cycle, temp_config
from .samples import manifest_v1

V1 = ROOT / "ai/models/bootstrap/zap-v1.zapw"
CYCLE = "20261121-2200"


def header(path: Path) -> dict:
    b = path.read_bytes()
    _, _, n = struct.unpack_from("<III", b, 0)
    return json.loads(b[12 : 12 + n])


class FakeTools:
    """Stands in for the subprocesses of run_train; the candidate's run stops after `cut` iterations."""

    def __init__(self, cut: int):
        self.cut = cut
        self.train: list[list[str]] = []

    @staticmethod
    def path(p: str) -> Path:
        q = Path(p)
        return q if q.is_absolute() else ROOT / q

    def __call__(self, cmd, log_path, env=None, deadline=None, heartbeat=None, **kw):
        if cmd[:3] == ["python", "-m", "zapcycle.init_actor"]:
            out = self.path(cmd[cmd.index("--out") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"init")
        elif cmd[:2] == ["python", "training/train.py"]:
            self.train.append(cmd)
            run = self.path(cmd[cmd.index("--run") + 1])
            iters = self.cut if len(self.train) == 1 else int(cmd[cmd.index("--iters") + 1])
            run.mkdir(parents=True, exist_ok=True)
            (run / "metrics.jsonl").write_text("".join(json.dumps({"iteration": i + 1, "setups": {"snapshots": 3}}) + "\n" for i in range(iters)))
            shutil.copy(V1, run / "current.zapw")
        elif cmd[:2] == ["node", "ai/bench/export-model.ts"]:
            out = Path(cmd[3])
            v = cmd[cmd.index("--version") + 1]
            out.mkdir(parents=True, exist_ok=True)
            f = out / f"zap-{v}.zapw"
            shutil.copy(V1, f)
            (out / "manifest.json").write_text(json.dumps({"version": v, "file": f.name, "sha256": sha256_file(f)}))
        elif cmd[:2] == ["node", "ai/bench/calibrate-personas.ts"]:
            out = Path(cmd[cmd.index("--out") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text("{}")
        else:
            raise AssertionError(f"unexpected command {cmd[:3]}")
        return ""


class TwinTest(unittest.TestCase):
    def setUp(self):
        self.cfg, self.tmp = temp_config("test")
        self.cyc, self.s3 = fake_cycle(self.cfg)
        m = manifest_v1()
        for n in range(2, 5):
            v = f"v{n}"
            f = self.cyc.version_dir(v) / "model.zapw"
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(f"model {v}".encode())
            m["models"][v] = {**m["models"]["v1"], "sha256": sha256_file(f), "bytes": f.stat().st_size}
        self.s3.put_object(self.cfg.storage["models_bucket"], "manifest.json", formats.dumps(m), "application/json")
        self.cyc.state["promotions"] = [{"version": f"v{n}", "at": n, "parent": f"v{n - 1}"} for n in range(2, 5)]
        self.human = self.tmp / "human-model.zapw"
        shutil.copy(V1, self.human)

    def run_with(self, human: Path | None, cut: int) -> tuple[FakeTools, dict]:
        tools = FakeTools(cut)
        h = HumanResult(layers={}, human_model=human, human_model_report={"sha256": "0" * 64, "pass": True} if human else None)
        with mock.patch.object(proc, "run", tools):
            out = run_train(self.cyc, CYCLE, h, self.cyc.clock(), self.tmp / "run.log")
        return tools, out

    @staticmethod
    def opt(cmd: list[str], name: str) -> str:
        return cmd[cmd.index(name) + 1]

    def test_same_seed_same_compute_the_mix_without_the_human_model(self):
        tools, out = self.run_with(self.human, cut=1)
        cand, tw, floor = tools.train
        names = [Path(self.opt(c, "--run")).name for c in tools.train]
        self.assertEqual(names, ["candidate", "twin", "twin-b"], "the first cycle with the twin also measures the seed floor")
        seed = seed_base(CYCLE)
        self.assertEqual([self.opt(c, "--seed-base") for c in tools.train], [seed, seed, bump_seed(seed)])
        self.assertEqual(self.opt(cand, "--iters"), str(self.cfg.train["iters"]))
        self.assertEqual(self.opt(tw, "--iters"), "1", "the twin runs what the candidate really ran")
        self.assertEqual(self.opt(floor, "--iters"), "1")
        for c in (tw, floor):
            self.assertEqual(self.opt(c, "--league-size"), self.opt(cand, "--league-size"))
            self.assertEqual(self.opt(c, "--league-fixed"), self.opt(cand, "--league-fixed"))
        self.assertEqual(self.opt(cand, "--league-fixed").split(","), [rel(self.cyc.version_dir(v) / "model.zapw") for v in ("v2", "v3", "v4")])
        self.assertEqual(self.opt(cand, "--league-mix"), with_human(self.cfg.train["league_mix"], 0.08))
        self.assertEqual(self.opt(tw, "--league-mix"), self.cfg.train["league_mix"])
        self.assertEqual(self.opt(floor, "--league-mix"), self.cfg.train["league_mix"])
        self.assertEqual(self.opt(cand, "--human-model"), str(self.human))
        self.assertNotIn("--human-model", tw)
        self.assertNotIn("--human-model", floor)
        varying = {"--run", "--seed-base", "--iters", "--max-hours", "--league-mix", "--human-model"}

        def same(c):
            return [x for i, x in enumerate(c) if x not in varying and (i == 0 or c[i - 1] not in varying)]

        self.assertEqual(same(cand), same(tw))
        self.assertEqual(same(tw), same(floor))
        runs = self.cfg.work_dir / CYCLE / "runs"
        for name in ("candidate", "twin", "twin-b"):
            self.assertFalse((runs / name / "league").exists(), "the cycle copies nothing into a run's league folder")
        self.assertEqual(out["training"]["leagueFiles"], self.opt(cand, "--league-fixed").split(","))
        t = out["twin"]
        self.assertEqual(t["iterations"], {"candidate": 1, "twin": 1, "twin-b": 1})
        self.assertEqual(t["seedBase"], {"candidate": seed, "twin": seed, "twin-b": bump_seed(seed)})
        for f in (t["snapshot"], t["floor"]):
            h = header(Path(f))
            self.assertEqual(h["features"], "v1")
            self.assertTrue(all(x["dtype"] == "i8" for x in h["tensors"] if x["name"].endswith(".weight")), "compared in int8, like the candidate's export")
        self.assertEqual(out["training"]["humanModel"], {"sha256": "0" * 64, "pass": True})

    def test_no_twin_without_the_human_model(self):
        tools, out = self.run_with(None, cut=2)
        self.assertEqual(len(tools.train), 1)
        self.assertIsNone(out["twin"])

    def test_seed_floor_only_every_few_cycles(self):
        self.cyc.state["seedFloor"] = {"cycleId": "20261114-2200", "pairs": 8, "mean": 0.5, "lo": 0.4, "hi": 0.6}
        self.cyc.state["cyclesSinceSeedFloor"] = 1
        tools, out = self.run_with(self.human, cut=2)
        self.assertEqual([Path(self.opt(c, "--run")).name for c in tools.train], ["candidate", "twin"])
        self.assertIsNone(out["twin"]["floor"])
        self.cyc.state["cyclesSinceSeedFloor"] = int(self.cfg.train["seed_floor_every"]) - 1
        tools, _ = self.run_with(self.human, cut=2)
        self.assertEqual(len(tools.train), 3)

    def test_the_card_carries_the_latest_floor_and_the_noise_scale(self):
        from zapcycle.gate import seed_floor

        self.assertEqual(seed_floor({"seedFloor": None, "seedFloors": []}, CYCLE, None), {"seedFloor": None, "seedFloorCycle": None, "seedNoise": None})
        m = {"pairs": 8, "mean": 0.53, "lo": 0.4, "hi": 0.66}
        got = seed_floor({"seedFloor": None, "seedFloors": []}, CYCLE, m)
        self.assertEqual((got["seedFloor"], got["seedFloorCycle"], got["seedNoise"]), (m, CYCLE, {"floors": 1, "rms": 0.03}))
        old = {"cycleId": "20261114-2200", **m}
        st = {"seedFloor": old, "seedFloors": [{"cycleId": "20261107-2200", **m, "mean": 0.46}, old]}
        carried = seed_floor(st, CYCLE, None)
        self.assertEqual((carried["seedFloor"], carried["seedFloorCycle"]), (m, "20261114-2200"))
        self.assertEqual(carried["seedNoise"], {"floors": 2, "rms": round(((0.04**2 + 0.03**2) / 2) ** 0.5, 4)})

    def test_finish_keeps_every_floor_measured_in_the_cycle(self):
        from zapcycle.cli import Steps, finish_ok

        gate_dir = self.cyc.work(CYCLE) / "gate"
        gate_dir.mkdir(parents=True, exist_ok=True)
        m = {"pairs": 8, "mean": 0.53, "lo": 0.4, "hi": 0.66}
        (gate_dir / "twin.json").write_text(json.dumps({"sha256": "1" * 64, "headToHead": m, "seedFloor": m, "seedFloorCycle": CYCLE, "seedNoise": {"floors": 1, "rms": 0.03}}))
        finish_ok(self.cyc, Steps(self.cyc, CYCLE, 1), {"result": "promoted", "version": "v5"})
        self.assertEqual(self.cyc.state["seedFloors"], [{"cycleId": CYCLE, **m}])
        self.assertEqual(self.cyc.state["cyclesSinceSeedFloor"], 0)
        # A floor carried from an earlier cycle is not counted again.
        (gate_dir / "twin.json").write_text(json.dumps({"sha256": "1" * 64, "headToHead": m, "seedFloor": m, "seedFloorCycle": "20261114-2200", "seedNoise": {"floors": 1, "rms": 0.03}}))
        finish_ok(self.cyc, Steps(self.cyc, CYCLE, 1), {"result": "promoted", "version": "v5"})
        self.assertEqual(len(self.cyc.state["seedFloors"]), 1)
        self.assertEqual(self.cyc.state["cyclesSinceSeedFloor"], 1)

    def test_quantize_keeps_the_weights(self):
        out = twin.quantize(V1, self.tmp / "q.zapw")
        a, b = header(V1), header(out)
        self.assertEqual((a["features"], a["inputs"], a["hidden"]), (b["features"], b["inputs"], b["hidden"]))
        self.assertLess(abs(out.stat().st_size - V1.stat().st_size), 4096)
        self.assertEqual(twin.same_compute(390, 120), 120)
        self.assertEqual(twin.same_compute(390, 0), 390)


if __name__ == "__main__":
    unittest.main()
