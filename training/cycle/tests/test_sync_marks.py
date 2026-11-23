import json
import unittest
from datetime import datetime, timezone

from zapcycle.errors import CycleError
from zapcycle.index import Index
from zapcycle.sync import day_prefixes, sync

from .helpers import fake_cycle, temp_config

NOW = int(datetime(2026, 11, 21, 12, tzinfo=timezone.utc).timestamp() * 1000)
KEY = "matches/v1/2026/11/21/0b6f3a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.json"


def record(schema: str, test: bool | None) -> bytes:
    r = {"schema": schema, "matchId": "0b6f3a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "endedAt": NOW - 1000}
    if test is not None:
        r["test"] = test
    return json.dumps(r).encode()


class SyncMarksTest(unittest.TestCase):
    def test_days_listed(self):
        self.assertEqual(day_prefixes(None, "2026-11-21"), ["matches/v1/"])
        self.assertEqual(day_prefixes("2026-11-20", "2026-11-21"), ["matches/v1/2026/11/19/", "matches/v1/2026/11/20/", "matches/v1/2026/11/21/"])

    def test_a_test_record_fails_a_production_cycle(self):
        cfg, _ = temp_config("prod")
        cyc, s3 = fake_cycle(cfg, clock=lambda: NOW)
        s3.put_object("zap-events", KEY, record("zap-match/2", True), "application/json")
        with self.assertRaisesRegex(CycleError, f"test record in production: {KEY}"):
            sync(cyc)

    def test_production_records_are_kept_in_r2_mode(self):
        cfg, _ = temp_config("prod")
        cyc, s3 = fake_cycle(cfg, clock=lambda: NOW)
        s3.put_object("zap-events", KEY, record("zap-match/2", False), "application/json")
        s3.put_object("zap-events", KEY.replace("0b6f", "1b6f"), record("zap-match/1", None), "application/json")
        out = sync(cyc)
        self.assertEqual(out["downloaded"], 2)
        self.assertTrue((cfg.data_dir / "records" / KEY).exists())
        self.assertEqual(cyc.state["cursorDate"], "2026-11-21")
        again = sync(cyc)
        self.assertEqual((again["downloaded"], again["unchanged"]), (0, 2))

    def test_local_sync_counts_production_records_as_invalid(self):
        cfg, _ = temp_config("test")
        cyc, s3 = fake_cycle(cfg, clock=lambda: NOW)
        b = cfg.storage["events_bucket"]
        s3.put_object(b, KEY, record("zap-match/2", False), "application/json")
        s3.put_object(b, KEY.replace("0b6f", "2b6f"), record("zap-match/1", None), "application/json")
        s3.put_object(b, KEY.replace("0b6f", "3b6f"), record("zap-match/2", True), "application/json")
        out = sync(cyc)
        self.assertEqual(out["notTest"], 2)
        idx = Index(cfg.data_dir / "index.sqlite")
        rows = dict(idx.db.execute("SELECT key, error FROM records").fetchall())
        idx.close()
        self.assertEqual(rows[KEY], "not a test record")
        self.assertIsNone(rows[KEY.replace("0b6f", "3b6f")])

    def test_large_records_and_partial_exports(self):
        cfg, _ = temp_config("test")
        cyc, s3 = fake_cycle(cfg, clock=lambda: NOW)
        b = cfg.storage["events_bucket"]
        s3.put_object(b, KEY, b"x" * (256 * 1024 + 1), "application/json")
        base = {"schema": "zap-export/1", "createdAt": NOW, "rows": [], "reports": []}
        s3.put_object(b, "exports/2026-11-20.json", json.dumps({**base, "date": "2026-11-20", "partial": False}).encode(), "application/json")
        s3.put_object(b, "exports/2026-11-21.json", json.dumps({**base, "date": "2026-11-21", "partial": True}).encode(), "application/json")
        s3.put_object(b, "exports/2026-11-22.json", json.dumps({**base, "date": "2026-11-22", "partial": False}).encode(), "application/json")
        out = sync(cyc)
        self.assertEqual(out["tooLarge"], 1)
        self.assertFalse((cfg.data_dir / "records" / KEY).exists())
        # The newest export up to today is partial, so the one before it is taken; tomorrow's is ignored.
        self.assertEqual(out["export"]["date"], "2026-11-20")
        self.assertEqual(json.loads((cfg.data_dir / "exports" / "latest.json").read_text())["date"], "2026-11-20")
