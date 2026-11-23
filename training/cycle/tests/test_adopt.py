import json
import shutil
import unittest
from datetime import datetime, timezone
from unittest import mock

from zapcycle import formats
from zapcycle.config import ROOT
from zapcycle.core import sha256_file, write_json
from zapcycle.publish import adopt, init, publish

from .helpers import fake_cycle, temp_config
from .samples import BUNDLED, gate_result

T0 = int(datetime(2026, 11, 22, 12, tzinfo=timezone.utc).timestamp() * 1000)


class AdoptTest(unittest.TestCase):
    def test_an_export_becomes_the_next_candidate(self):
        cfg, tmp = temp_config("test")
        cyc, s3 = fake_cycle(cfg, clock=lambda: T0)
        init(cyc)
        run = tmp / "runs" / "m6-adaptive"
        (run / "league").mkdir(parents=True)
        shutil.copy(ROOT / "training/runs/main/league/it000150.zapw", run / "league" / "it000150.zapw")
        write_json(run / "args.json", {"run": "training/runs/m6-adaptive", "iters": 390, "features": "v1", "seed_base": "6a", "lr": 0.0003, "init_actor": ""})
        # metrics.jsonl gives the training time up to the snapshot: iterations before 150 only, and
        # the last line of an iteration a resumed run logged twice.
        lines = [
            {"iteration": 148, "selfplay_seconds": 10.0, "learn_seconds": 5.0, "eval_seconds": 1.0},
            {"iteration": 149, "selfplay_seconds": 99.0, "learn_seconds": 0.0},
            {"iteration": 149, "selfplay_seconds": 11.0, "learn_seconds": 6.0, "eval_seconds": 0.5},
            {"iteration": 150, "selfplay_seconds": 1000.0, "learn_seconds": 1000.0},
        ]
        (run / "metrics.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
        exp_dir = run / "export"
        write_json(exp_dir / "manifest.json", {"version": "v2", "file": "zap-v2.zapw", "source": str(run / "league" / "it000150.zapw"), "adapt": None})

        def fake_export(cyc_, work, source, version, adapt, log_path, note, heartbeat=None):
            out = work / "export"
            out.mkdir(parents=True, exist_ok=True)
            f = out / f"zap-{version}.zapw"
            f.write_bytes((ROOT / "ai/models/bootstrap/zap-v1.zapw").read_bytes() + b"adopted")
            man = {"version": version, "file": f.name, "bytes": f.stat().st_size, "sha256": sha256_file(f), "arch": "mlp-v1", "features": "v1", "inputs": 431, "hidden": [256, 256], "adapt": adapt, "personas": BUNDLED["personas"], "source": str(source)}
            write_json(out / "manifest.json", man)
            return man

        with mock.patch("zapcycle.train.export_candidate", fake_export):
            t = adopt(cyc, "20261122-1200", exp_dir, tmp / "run.log")
        self.assertEqual((t["version"], t["parent"]), ("v2", "v1"))
        self.assertEqual(t["training"]["iterations"], 150)
        self.assertEqual(t["training"]["seconds"], 33.5)
        self.assertEqual(t["training"]["seedBase"], "6a")
        self.assertIn("--iters", t["training"]["args"])
        self.assertNotIn("--init-actor", t["training"]["args"])
        self.assertIsNone(t["checkpoint"])
        work = cyc.work("20261122-1200")
        man = t["export"]["manifest"]
        write_json(work / "gate" / "result.json", gate_result("v2", man["sha256"], "v1", cyc.require_manifest()["models"]["v1"]["sha256"], True))
        spec = {
            "panel": [{"member": "random", "agent": {"kind": "random"}}, {"member": "tuned", "agent": {"kind": "heuristic", "params": "tuned"}}, {"member": "v1", "agent": {"kind": "net", "model": "ai/models/bootstrap/zap-v1.zapw", "knobs": "zap"}}],
            "threads": 3,
            "stats": "empty",
            "sprt": {"p0": 0.5, "p1": 0.515, "alpha": 0.05, "beta": 0.05, "batchPairs": 400, "capPairs": 40000},
            "segments": {"pairs": 2500, "margin": 0.015},
            "panelTest": {"pairs": 2500, "margin": 0.01},
        }
        write_json(work / "gate" / "spec.json", spec)
        r = publish(cyc, "20261122-1200")
        self.assertEqual(r["result"], "promoted")
        card = json.loads(s3.buckets[cfg.storage["models_bucket"]]["cards/v2.json"]["body"])
        formats.check("zap-card/1", card)
        self.assertEqual(card["parent"], "v1")
        self.assertEqual(card["training"]["seconds"], 33.5)
        # zap-card/1 has no field for the gate's rules, so the reason names them.
        self.assertTrue(card["reason"].startswith("Passed every rule of the gate (SPRT 0.5 against 0.515, alpha 0.05, beta 0.05, rounds of 400 pairs up to 40000; segments: non-inferiority 1.5 points on 2500 pairs each; panel random, tuned (heuristic tuned), v1 (zap-v1.zapw, knobs zap): 1 point on 2500 pairs per segment; statistics empty; 3 threads"), card["reason"])
        self.assertLessEqual(len(card["reason"]), 500)
