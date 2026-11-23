import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from zapcycle import formats
from zapcycle.config import ROOT
from zapcycle.core import sha256_file
from zapcycle.gate import FIXED_MEMBERS, panel
from zapcycle.errors import CycleError
from zapcycle.train import final_snapshot, league_files, seed_base, train_command, with_human

from .helpers import fake_cycle, temp_config
from .samples import manifest_v1


def zapw(path: Path, meta: dict) -> None:
    header = json.dumps({"arch": "mlp-v1", "features": "v1", "inputs": 1, "hidden": [1], "policy": 1, "value": 1, "tensors": [], "meta": meta}).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<III", 0x5750415A, 1, len(header)) + header)


class TrainCommandTest(unittest.TestCase):
    def setUp(self):
        self.cfg, self.tmp = temp_config("test")
        self.cyc, self.s3 = fake_cycle(self.cfg)
        m = manifest_v1()
        for n in range(2, 7):
            v = f"v{n}"
            f = self.cyc.version_dir(v) / "model.zapw"
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(f"model {v}".encode())
            m["models"][v] = {**m["models"]["v1"], "sha256": sha256_file(f), "bytes": f.stat().st_size}
        formats.check("zap-manifest/1", m)
        self.s3.put_object(self.cfg.storage["models_bucket"], "manifest.json", formats.dumps(m), "application/json")
        self.cyc.state["promotions"] = [{"version": f"v{n}", "at": n, "parent": f"v{n - 1}"} for n in range(2, 7)]

    def test_seed_base_follows_the_cycle_id(self):
        self.assertEqual(seed_base("20261121-2200"), hashlib.sha256(b"20261121-2200").hexdigest()[:2])
        self.assertNotEqual(seed_base("20261121-2200"), seed_base("20261128-2200"))

    def test_command(self):
        run = self.cfg.work_dir / "c" / "runs" / "candidate"
        cmd = train_command(self.cyc, run, {"features": "v2", "hidden": "256,256", "adapt_beta": 0.3, "adapt_nw": 3.0}, "ai/models/opponent-priors.json", self.tmp / "init.pt", "d9", 0.5, ["a.zapw", "b.zapw", "c.zapw"])
        self.assertEqual(cmd[:2], ["python", "training/train.py"])
        joined = " ".join(cmd)
        for part in ("--features v2", "--priors ai/models/opponent-priors.json", "--critic-warmup 1", "--iters 2", "--decisions 5000", "--workers 1", "--threads 1", "--hidden 256,256", "--league-size 8", "--league-fixed a.zapw,b.zapw,c.zapw", "--seed-base d9", "--max-hours 0.500", "--adapt-beta 0.3", "--adapt-nw 3.0"):
            self.assertIn(part, joined)
        self.assertIn("characters=0.16", cmd[cmd.index("--league-mix") + 1])
        self.assertNotIn("human=", cmd[cmd.index("--league-mix") + 1])
        self.assertNotIn("--human-model", cmd)
        self.assertEqual(cmd[-len(self.cfg.train["fixed_args"]) :], self.cfg.train["fixed_args"])
        v1 = train_command(self.cyc, run, {"features": "v1"}, None, self.tmp / "init.pt", "d9", 0.5, [])
        self.assertNotIn("--priors", v1)
        self.assertNotIn("--adapt-beta", v1)
        self.assertEqual(v1[v1.index("--league-fixed") + 1], "")

    def test_command_with_the_human_model(self):
        run = self.cfg.work_dir / "c" / "runs" / "candidate"
        human = self.tmp / "human.zapw"
        cmd = train_command(self.cyc, run, {"features": "v1"}, None, self.tmp / "init.pt", "d9", 0.5, [], None, human)
        self.assertEqual(cmd[cmd.index("--human-model") + 1], str(human))
        share = self.cfg.human["model"]["league_share"]
        self.assertEqual(cmd[cmd.index("--league-mix") + 1], with_human(self.cfg.train["league_mix"], share))

    def test_league_holds_the_last_promoted_versions(self):
        files = league_files(self.cyc)
        self.assertEqual([f.split("/")[-2] for f in files], ["v4", "v5", "v6"])
        self.assertTrue(all(f.endswith("/model.zapw") and (ROOT / f).is_file() for f in files))

    def test_with_human(self):
        mix = with_human("current=0.30,snapshots=0.10,v1=0.60", 0.08)
        self.assertEqual(mix, "current=0.22,snapshots=0.10,v1=0.60,human=0.08")
        with self.assertRaises(CycleError):
            with_human("current=0.05,v1=0.95", 0.08)
        with self.assertRaises(CycleError):
            with_human("current=0.30,v1=0.70", 0)

    def test_panel_members(self):
        m = self.cyc.require_manifest()
        members = [p["member"] for p in panel(self.cyc, m)]
        self.assertEqual(members, ["random", "base", "tuned", "v1", "v4", "v5", "v6"])
        self.assertEqual(panel(self.cyc, m)[:4], FIXED_MEMBERS)

    def test_final_snapshot(self):
        run = self.tmp / "r"
        zapw(run / "current.zapw", {"iteration": 2})
        self.assertEqual(final_snapshot(run), run / "current.zapw")
        zapw(run / "league" / "it000002.zapw", {"iteration": 2})
        self.assertEqual(final_snapshot(run), run / "league" / "it000002.zapw")


class InitActorTest(unittest.TestCase):
    def test_warm_start_from_the_bundled_int8_file(self):
        out = Path(tempfile.mkdtemp()) / "init-actor.pt"
        r = subprocess.run([sys.executable, "-m", "zapcycle.init_actor", "--zapw", "ai/models/bootstrap/zap-v1.zapw", "--out", str(out)], cwd=ROOT, env={"PYTHONPATH": str(ROOT / "training/cycle"), "PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["inputs"], 431)
        code = (
            "import sys, torch; sys.path.insert(0, 'training'); from learner import Actor; from warm_start import read_zapw;"
            f"s = torch.load({str(out)!r}, weights_only=True); a = Actor(431, [256, 256]); a.load_state_dict(s);"
            "h, t = read_zapw(__import__('pathlib').Path('ai/models/bootstrap/zap-v1.zapw'));"
            "print(max(float((s[k] - torch.from_numpy(t[k])).abs().max()) for k in s))"
        )
        r = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(float(r.stdout.strip()), 0.0)
