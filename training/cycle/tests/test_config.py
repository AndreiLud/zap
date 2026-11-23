import unittest

from zapcycle.config import flat_keys, load_config
from zapcycle.errors import CycleError

from .helpers import CONFIG_DIR, temp_config


class ConfigTest(unittest.TestCase):
    def test_three_files_have_the_same_keys(self):
        keys = {p: flat_keys(load_config(CONFIG_DIR / f"{p}.toml", env={}).raw) for p in ("prod", "local", "test")}
        self.assertEqual(keys["prod"], keys["local"])
        self.assertEqual(keys["prod"], keys["test"])

    def test_prod_values(self):
        c = load_config(CONFIG_DIR / "prod.toml", env={})
        self.assertEqual(c.mode, "r2")
        self.assertEqual(c.storage["endpoint"], "")
        self.assertEqual((c.storage["events_bucket"], c.storage["models_bucket"], c.storage["public_bucket"]), ("zap-events", "zap-models", "zap-public"))
        self.assertEqual((c.schedule["weekday"], c.schedule["time"], c.schedule["timezone"]), (5, "22:00", "America/Sao_Paulo"))
        self.assertEqual(c.schedule["max_cycle_hours"], 36)
        self.assertEqual((c.gate["p0"], c.gate["p1"], c.gate["alpha"], c.gate["beta"], c.gate["cap_pairs"]), (0.5, 0.515, 0.05, 0.05, 40000))
        self.assertEqual((c.gate["segment_margin"], c.gate["panel_margin"], c.gate["panel_versions"]), (0.015, 0.01, 3))
        self.assertEqual((c.ab["share"], c.ab["days"], c.ab["rollback_drop"]), (0.3, 14, 0.02))
        self.assertEqual(c.data["device_cap"], 0.02)
        self.assertIn("characters=0.16", c.train["league_mix"])
        self.assertEqual(c.storage["bundled"], ["v1", "v2"])

    def test_local_and_test_profiles_stay_local(self):
        for p, prefix in (("local", "zap-test-"), ("test", "zap-test-unit-")):
            c = load_config(CONFIG_DIR / f"{p}.toml", env={})
            self.assertEqual(c.mode, "minio")
            self.assertEqual(c.storage["endpoint"], "http://minio:9000")
            for k in ("events", "models", "public"):
                self.assertTrue(c.storage[f"{k}_bucket"].startswith(prefix))
            self.assertEqual((c.train["workers"], c.train["threads"], c.gate["threads"]), (1, 1, 1))
            self.assertEqual(c.storage["bundled"], ["v1"])
            self.assertTrue(str(c.data_dir).endswith(f"training/cycle/data/{p}"))

    def test_flags_look_back_stays_inside_the_grace_after_a_clear(self):
        # The Worker ignores a flag that comes less than CLEARED_GRACE_MS after a clear; the cycle
        # must look back less than that, or a flag right after the grace reuses judged evidence.
        import re

        from zapcycle.config import CLEARED_GRACE_DAYS, ROOT

        text = (ROOT / "worker" / "src" / "cycle-jobs.ts").read_text()
        days = int(re.search(r"CLEARED_GRACE_MS = (\d+) \* DAY_MS", text).group(1))
        self.assertEqual(days, CLEARED_GRACE_DAYS)
        tomls = [CONFIG_DIR / f"{p}.toml" for p in ("prod", "local", "test")] + sorted((ROOT / "tests" / "sim").glob("*.toml"))
        for path in tomls:
            c = load_config(path, env={})
            self.assertLess(c.human["flags"]["lookback_days"], days, path.name)
        cfg, _ = temp_config("test")
        with self.assertRaises(CycleError):
            load_config(self._with_lookback(cfg.path, 21), env={})

    @staticmethod
    def _with_lookback(path, days: int):
        import tempfile
        from pathlib import Path

        text = Path(path).read_text().replace("lookback_days = 14", f"lookback_days = {days}")
        out = Path(tempfile.mkdtemp()) / "lookback.toml"
        out.write_text(text)
        return out

    def test_test_thresholds_only_in_minio_mode(self):
        env = {"ZAP_CYCLE_TEST_THRESHOLDS": "1"}
        self.assertEqual(load_config(CONFIG_DIR / "local.toml", env=env).thresholds["human_model_matches"], 20)
        self.assertEqual(load_config(CONFIG_DIR / "local.toml", env=env).thresholds["human_model_devices"], 2)
        self.assertEqual(load_config(CONFIG_DIR / "prod.toml", env=env).thresholds["human_model_matches"], 500)

    def test_bad_values_are_refused(self):
        import tempfile
        from pathlib import Path

        text = (CONFIG_DIR / "prod.toml").read_text().replace('mode = "r2"', 'mode = "s3"')
        p = Path(tempfile.mkdtemp()) / "bad.toml"
        p.write_text(text)
        with self.assertRaises(CycleError):
            load_config(p, env={})
        p.write_text((CONFIG_DIR / "prod.toml").read_text().replace("[ab]", "[abc]"))
        with self.assertRaises(CycleError):
            load_config(p, env={})

    def test_temp_paths(self):
        cfg, tmp = temp_config()
        self.assertEqual(cfg.data_dir, tmp / "data")
        self.assertEqual(cfg.logs_dir, tmp / "logs")
