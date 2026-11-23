import tempfile
import unittest
from pathlib import Path
from unittest import mock

from zapcycle import bridge
from zapcycle.errors import GuardError

from .helpers import fake_cycle, temp_config


class BridgeGuardTest(unittest.TestCase):
    def test_refused_in_r2_mode(self):
        cfg, _ = temp_config("prod")
        cyc, s3 = fake_cycle(cfg)
        with self.assertRaisesRegex(GuardError, "minio mode"):
            bridge.push(cyc, "e2e")
        with self.assertRaisesRegex(GuardError, "minio mode"):
            bridge.pull(cyc, "e2e")
        self.assertEqual(s3.calls, [])

    def test_unknown_state(self):
        with self.assertRaises(GuardError):
            bridge.bridge_dir("../../etc")

    def test_push_and_pull_touch_only_the_test_buckets(self):
        cfg, _ = temp_config("test")
        cyc, s3 = fake_cycle(cfg)
        base = Path(tempfile.mkdtemp())
        ev = base / "e2e" / "events"
        (ev / "matches/v1/2026/11/21").mkdir(parents=True)
        (ev / "matches/v1/2026/11/21/a.json").write_text("{}")
        (ev / "exports").mkdir()
        (ev / "exports/2026-11-21.json").write_text("{}")
        (ev / "other").mkdir()
        (ev / "other/x.json").write_text("{}")
        s3.put_object(cfg.storage["models_bucket"], "manifest.json", b"{}", "application/json")
        s3.put_object(cfg.storage["models_bucket"], "models/v1.zapw", b"zz", "application/octet-stream")
        with mock.patch.object(bridge, "bridge_dir", lambda state: base / state):
            r = bridge.push(cyc, "e2e")
            self.assertEqual((r["sent"], r["unchanged"]), (2, 0))
            self.assertEqual(bridge.push(cyc, "e2e")["unchanged"], 2)
            self.assertEqual(bridge.pull(cyc, "e2e")["pulled"], 2)
        self.assertEqual((base / "e2e/models/models/v1.zapw").read_bytes(), b"zz")
        written = {b for op, b, _ in s3.calls if op == "put"} - {cfg.storage["models_bucket"]}
        self.assertEqual(written, {"zap-test-unit-events"})
        self.assertTrue(all(b.startswith("zap-test-") for b in s3.buckets))
