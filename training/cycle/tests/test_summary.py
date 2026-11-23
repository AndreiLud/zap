"""summary.json cells: only seats that may count in public numbers, and at least 20 people; and the
work folders of older cycles keep nothing keyed by a group token."""

import unittest

from zapcycle.summary import cells, public_seats

T0 = 1_793_577_600_000  # 2026-11-02 00:00 UTC, a Monday
HOUR = 3_600_000


def line(i: int, group: str | None, **seat) -> dict:
    h = {"seat": 0, "group": group, "weight": 1 if group else None, "flagged": False, "openDataOptOut": False, "abandoned": False}
    h.update(seat)
    return {"key": f"k{i}", "kind": "solo1", "segment": "paulista-2", "endedAt": T0 + 10 * HOUR + i * 1000, "test": False, "winner": i % 2, "humans": [h]}


class CellsTest(unittest.TestCase):
    def test_deleted_opted_out_and_flagged_seats_stay_out(self):
        # The reviewer's case: 19 ordinary people with one match each, then three people who
        # deleted their data, left open data or were flagged, with 100 matches each.
        recs = [line(i, f"{i:016x}") for i in range(19)]
        n = 19
        for kind in ("deleted", "opted-out", "flagged"):
            for _ in range(100):
                if kind == "deleted":
                    recs.append(line(n, None))
                elif kind == "opted-out":
                    recs.append(line(n, "a" * 16, openDataOptOut=True))
                else:
                    recs.append(line(n, "b" * 16, flagged=True, weight=0))
                n += 1
        self.assertEqual(cells(recs), [], "19 people who may count: below the floor of 20")
        recs.append(line(n, "c" * 16))
        out = cells(recs)
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["people"], out[0]["matches"]), (20, 20))
        self.assertEqual(out[0]["humanWinRate"], round(sum(1 for r in recs if public_seats(r) and r["winner"] == 0) / 20, 4))

    def test_weight_zero_and_friends_stay_out(self):
        recs = [line(i, f"{i:016x}") for i in range(25)]
        recs[0]["humans"][0]["weight"] = 0
        recs[1]["kind"] = "friends"
        out = cells(recs)
        self.assertEqual((out[0]["people"], out[0]["matches"]), (23, 23))


class PruneTest(unittest.TestCase):
    def test_older_work_folders_lose_their_per_person_tables(self):
        import json as _json

        from .helpers import fake_cycle, temp_config

        cfg, _ = temp_config("test")
        cyc, _ = fake_cycle(cfg)
        ids = [f"2026110{d}-2200" for d in range(1, 7)]
        for i in ids:
            w = cfg.work_dir / i
            for sub in ("tables", "human/profiles", "human/open-data", "gate"):
                (w / sub).mkdir(parents=True, exist_ok=True)
            (w / "tables" / "records.jsonl").write_text("{}\n")
            (w / "human" / "profiles" / "readings.jsonl").write_text("{}\n")
            (w / "human" / "report.json").write_text("{}")
            (w / "human" / "result.json").write_text(_json.dumps({"layers": {}}))
            (w / "card.json").write_text("{}")
        gone = cyc.prune_work()
        self.assertEqual(gone, ids[:2])
        kept = sorted(p.name for p in cfg.work_dir.iterdir())
        self.assertEqual(kept, ids[2:])
        for i in ids[2:-1]:
            w = cfg.work_dir / i
            self.assertFalse((w / "tables").exists())
            self.assertEqual([p.name for p in (w / "human").iterdir()], ["result.json"])
            self.assertTrue((w / "card.json").exists() and (w / "gate").exists())
        newest = cfg.work_dir / ids[-1]
        self.assertTrue((newest / "tables" / "records.jsonl").exists())
        self.assertTrue((newest / "human" / "profiles" / "readings.jsonl").exists())

    def test_a_failed_cycle_prunes_the_older_folders_and_keeps_its_own(self):
        from unittest import mock

        from zapcycle import cli

        from .helpers import fake_cycle, temp_config

        cfg, _ = temp_config("test")
        t_fail = 1_794_261_600_000  # 2026-11-09 22:00 UTC: the failed cycle, newer than the two below
        cyc, _ = fake_cycle(cfg, clock=lambda: t_fail)
        ok = ["20261101-2200", "20261102-2200"]
        for i in ok:
            (cfg.work_dir / i / "tables").mkdir(parents=True)
            (cfg.work_dir / i / "tables" / "records.jsonl").write_text("{}\n")

        def failing_build(c, st):
            t = c.work(st.cycle_id) / "tables"
            t.mkdir(parents=True, exist_ok=True)
            (t / "records.jsonl").write_text("{}\n")
            raise RuntimeError("build broke")

        with mock.patch.object(cyc, "require_manifest", return_value={"control": None, "controlUntil": None}), mock.patch.object(cli, "do_sync", return_value={}), mock.patch.object(cli, "records_count", return_value=0), mock.patch.object(cli, "do_build", failing_build):
            with self.assertRaises(RuntimeError):
                cli.cmd_run(cyc, None)
        failed = cli.new_cycle_id(t_fail)
        self.assertEqual(sorted(p.name for p in cfg.work_dir.iterdir()), [*ok, failed])
        for i in ok:
            self.assertFalse((cfg.work_dir / i / "tables").exists(), i)
        self.assertTrue((cfg.work_dir / failed / "tables" / "records.jsonl").exists(), "the failed cycle stays whole for a rerun")
        self.assertEqual(cyc.read_status()["state"], "failed")


if __name__ == "__main__":
    unittest.main()
