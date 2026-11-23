"""Automation flags: they fire on bots and stay quiet on varied people; the list of operations, the
owner's review tool and the upload follow contract 1.9."""

import json
import random
import unittest

from zapcycle import formats
from zapcycle.errors import CycleError
from zapcycle.human import flags

from .human_support import DAY, HOUR, T0, Tables, group, new_context, person_decisions


def people_and_bots(t: Tables, rng: random.Random, n_people: int = 40) -> dict[str, str]:
    """Varied people (6 matches each, daytime, log-normal times) and one bot per pattern."""
    expect: dict[str, str] = {}
    for p in range(n_people):
        g = group(p)
        median = rng.uniform(600, 2500)
        for j in range(6):
            start = T0 + rng.randrange(6) * DAY + rng.randrange(12, 20) * HOUR
            t.match(g, start, person_decisions(rng, rng.randrange(25, 45), median, rng.uniform(0.5, 0.8)))
    g = group(1, "metronome")
    for j in range(8):
        t.match(g, T0 + j * 17 * HOUR, [(rng.randrange(3), int(700 * (1 + 0.01 * rng.uniform(-1, 1)))) for _ in range(35)])
    expect[g] = "regular-times"
    g = group(2, "clock")
    for h in range(24):
        t.match(g, T0 + 2 * DAY + h * HOUR, person_decisions(rng, 30))
    expect[g] = "around-the-clock"
    # A fixed 700 ms delay as the server sees it, behind 90 ms of network jitter.
    g = group(5, "jitter")
    for j in range(8):
        t.match(g, T0 + j * 17 * HOUR, [(rng.randrange(3), max(1, int(rng.gauss(700, 90)))) for _ in range(35)])
    expect[g] = "regular-times"
    # A delay drawn at random from 0.6 to 0.9 s.
    g = group(6, "uniform")
    for j in range(8):
        t.match(g, T0 + j * 17 * HOUR + HOUR, [(rng.randrange(3), int(rng.uniform(600, 900))) for _ in range(35)])
    expect[g] = "regular-times"
    # A heavy person whose hours move during the week (24 distinct hours over 7 days, at most 16
    # within one day): a person, not a program.
    g = group(7, "shifts")
    for d in range(7):
        first = 8 if d < 3 else (16 if d < 5 else 0)
        for h in range(first, first + 8):
            t.match(g, T0 + d * DAY + h * HOUR, person_decisions(rng, 30))
    g = group(3, "volume")
    for j in range(400):
        t.match(g, T0 + (j // 80) * DAY + 10 * HOUR + (j % 80) * 450_000, person_decisions(rng, 3))
    expect[g] = "volume"
    g = group(4, "script")
    seq = person_decisions(rng, 45)
    for j in range(3):
        t.match(g, T0 + j * DAY + 15 * HOUR, seq)
    expect[g] = "identical-sequences"
    return expect


class FlagsTest(unittest.TestCase):
    def setUp(self):
        self.ctx, self.cyc, self.s3, self.tmp = new_context()
        self.models = self.cfg_bucket("models")

    def cfg_bucket(self, kind):
        return self.ctx.config.storage[f"{kind}_bucket"]

    def run_detection(self, t: Tables, **kw):
        t.write(self.ctx, **kw)
        return flags.run_flags(self.ctx)

    def test_bots_are_flagged_and_people_are_not(self):
        t = Tables()
        expect = people_and_bots(t, random.Random(1))
        lay, now_flagged, report = self.run_detection(t)
        self.assertTrue(lay["on"])
        self.assertEqual(lay["progress"]["people"], 47)
        doc = self.s3.json(self.models, flags.FLAGS_KEY)
        self.assertEqual(formats.validate("zap-flags/1", doc), [])
        got = {o["ref"].split(":")[1]: o["reason"] for o in doc["ops"]}
        self.assertEqual(got, expect, "every bot flagged for its pattern, no person flagged")
        self.assertEqual(now_flagged, set(expect))
        for o in doc["ops"]:
            self.assertTrue(o["ref"].startswith("2026-11-09:"))
            self.assertRegex(o["evidence"], formats.EVIDENCE)
            self.assertEqual(o["at"], self.ctx.now_ms)
        self.assertEqual(report["pending"], 6)
        texts = {o["ref"].split(":")[1]: o["evidence"] for o in doc["ops"]}
        self.assertRegex(texts[group(5, "jitter")], r"^time spread 0\.[0-3]\d\d over 280 decisions, median \d+ ms$")

    def test_time_spread(self):
        self.assertEqual(flags.time_spread([100.0] * 10), (0.0, 100.0))
        spread, median = flags.time_spread([float(x) for x in range(1, 101)])
        self.assertEqual(median, 51.0)
        self.assertAlmostEqual(spread, (91 - 11) / 51)

    def test_a_second_run_adds_nothing_and_uploads_nothing(self):
        t = Tables()
        people_and_bots(t, random.Random(2), 5)
        self.run_detection(t)
        first = self.s3.json(self.models, flags.FLAGS_KEY)
        puts = sum(1 for c in self.s3.calls if c[0] == "put" and c[2] == flags.FLAGS_KEY)
        _, _, report = flags.run_flags(self.ctx)
        self.assertFalse(report["upload"]["uploaded"])
        self.assertEqual(self.s3.json(self.models, flags.FLAGS_KEY), first)
        self.assertEqual(sum(1 for c in self.s3.calls if c[0] == "put" and c[2] == flags.FLAGS_KEY), puts)

    def test_a_group_the_export_already_flags_is_skipped(self):
        t = Tables()
        g = group(9, "metronome")
        for j in range(8):
            t.match(g, T0 + j * HOUR, [(0, 700)] * 35, flagged=True)
        lay, _, _ = self.run_detection(t)
        self.assertEqual(self.s3.json(self.models, flags.FLAGS_KEY)["ops"], [])

    def test_old_matches_are_outside_the_window(self):
        t = Tables()
        g = group(5, "metronome")
        for j in range(8):
            t.match(g, T0 - 30 * DAY + j * HOUR, [(0, 700)] * 35)
        self.run_detection(t)
        self.assertEqual(self.s3.json(self.models, flags.FLAGS_KEY)["ops"], [])

    def test_automatic_and_forced_moves_do_not_count_as_regular(self):
        t = Tables()
        g = group(6, "auto")
        for j in range(8):
            t.match(g, T0 + j * HOUR, [(0, 700)] * 35, legal=0b1)
        self.run_detection(t)
        self.assertEqual(self.s3.json(self.models, flags.FLAGS_KEY)["ops"], [])

    def test_review_tool(self):
        t = Tables()
        expect = people_and_bots(t, random.Random(3), 3)
        reports = [{"id": 7, "day": "2026-11-08", "reason": "nickname", "matchId": None, "seat": 0, "group": group(0)}, {"id": 8, "day": "2026-11-08", "reason": "other", "matchId": None, "seat": 1, "group": None}]
        self.run_detection(t, reports=reports)
        listed = flags.cmd_list(self.ctx)
        self.assertEqual({p["ref"].split(":")[1] for p in listed["pending"]}, set(expect))
        self.assertEqual(listed["pending"][0]["receipt"]["status"], "not imported yet")
        by_group = {r["group"]: r["reports"] for r in listed["reports"]}
        self.assertEqual(by_group[group(0)], [{"id": 7, "day": "2026-11-08", "reason": "nickname"}])
        text = json.dumps(listed)
        for line in t.lines:
            self.assertNotIn(line["matchId"], text, "the list shows group tokens and evidence, never match ids")
        # A receipt that names a ref shows its import status.
        ref = listed["pending"][0]["ref"]
        rec = self.ctx.data_dir / "receipts"
        rec.mkdir(parents=True)
        (rec / "2026-11-10.json").write_text(json.dumps({"jobs": {"flags": {"applied": [ref], "ignored": [], "unresolved": [], "reviewed": []}}}))
        self.assertEqual(flags.cmd_list(self.ctx)["pending"][0]["receipt"]["status"], "applied")
        r = flags.cmd_review(self.ctx, "confirm", ref)
        self.assertEqual(r["pending"], 5)
        with self.assertRaises(CycleError):
            flags.cmd_review(self.ctx, "clear", ref)
        with self.assertRaises(CycleError):
            flags.cmd_review(self.ctx, "clear", "2026-11-09:" + "0" * 16)
        with self.assertRaises(CycleError):
            flags.cmd_review(self.ctx, "clear", "not a ref")
        other = flags.cmd_list(self.ctx)["pending"][0]["ref"]
        flags.cmd_review(self.ctx, "clear", other)
        up = flags.cmd_push(self.ctx)
        self.assertTrue(up["uploaded"])
        doc = self.s3.json(self.models, flags.FLAGS_KEY)
        self.assertEqual(formats.validate("zap-flags/1", doc), [])
        self.assertEqual([o["op"] for o in doc["ops"][-2:]], ["confirm", "clear"])
        self.assertEqual(len(flags.cmd_list(self.ctx)["pending"]), 4)

    def test_old_operations_drop_out_and_the_list_keeps_5000(self):
        now = T0 + 500 * DAY
        doc = {"schema": "zap-flags/1", "createdAt": now, "ops": [{"ref": f"2026-11-09:{i:016x}", "op": "flag", "reason": "volume", "evidence": "x", "at": T0 + (i % 2) * 450 * DAY} for i in range(5200)]}
        out = flags.save_ops(self.ctx, doc, now)
        self.assertEqual(formats.validate("zap-flags/1", out), [])
        self.assertTrue(all(o["at"] >= now - 400 * DAY for o in out["ops"]))
        self.assertEqual(len(out["ops"]), 2600)
        doc["ops"] = [{"ref": f"2026-11-09:{i:016x}", "op": "flag", "reason": "volume", "evidence": "x", "at": now} for i in range(5200)]
        out = flags.save_ops(self.ctx, doc, now)
        self.assertEqual(len(out["ops"]), 5000)
        self.assertEqual(out["ops"][-1]["ref"], f"2026-11-09:{5199:016x}")

    def test_no_export_means_off(self):
        lay, ex, _ = flags.run_flags(self.ctx)
        self.assertFalse(lay["on"])
        self.assertEqual(ex, set())

    def test_window_helpers(self):
        self.assertEqual(flags._max_in_window([0, 1, 2, 10 * DAY], 7 * DAY), 3)
        hours = [T0 + h * HOUR for h in range(24)]
        self.assertEqual(flags._max_hours_in_window(hours, 7 * DAY), 24)
        self.assertEqual(flags._max_hours_in_window([T0 + d * DAY for d in range(30)], 7 * DAY), 1)
        self.assertEqual(flags.clean_evidence("cv 0.01 over 300 decisions <script>" + "x" * 300)[:33], "cv 0.01 over 300 decisions script")
        self.assertLessEqual(len(flags.clean_evidence("y" * 500)), 200)


if __name__ == "__main__":
    unittest.main()
