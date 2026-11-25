import json
import unittest
from datetime import datetime, timezone

from zapcycle import formats
from zapcycle.ab import run_ab
from zapcycle.cli import cmd_run, cmd_status
from zapcycle.errors import CycleError, GuardError
from zapcycle.publish import init, publish, rollback
from zapcycle.state import load_state

from .helpers import fake_cycle, temp_config
from .samples import make_candidate

T0 = int(datetime(2026, 11, 22, 12, tzinfo=timezone.utc).timestamp() * 1000)
DAY = 86_400_000


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.cfg, self.tmp = temp_config("test")
        self.clock = Clock()
        self.cyc, self.s3 = fake_cycle(self.cfg, clock=self.clock)
        self.M = self.cfg.storage["models_bucket"]
        self.P = self.cfg.storage["public_bucket"]
        init(self.cyc)

    def puts(self, since=0):
        return [(b, k) for op, b, k in self.s3.calls[since:] if op == "put"]

    def test_init_uploads_v1_once(self):
        self.assertEqual(self.puts(), [(self.M, "models/v1.zapw"), (self.M, "cards/v1.json"), (self.M, "manifest.json"), (self.M, "status/training.json")])
        m = self.s3.json(self.M, "manifest.json")
        formats.check("zap-manifest/1", m)
        self.assertEqual((m["current"], m["control"], m["controlShare"], m["controlUntil"]), ("v1", None, 0.3, None))
        self.assertEqual(self.s3.json(self.M, "cards/v1.json")["result"], "bootstrap")
        self.assertEqual(self.s3.json(self.M, "status/training.json")["state"], "ok")
        self.assertTrue((self.cfg.data_dir / "versions" / "v1" / "model.zapw").exists())
        n = len(self.s3.calls)
        self.assertFalse(init(self.cyc)["initialized"])
        self.assertEqual(self.puts(n), [])
        self.assertIn("zap-test-unit-events", self.s3.buckets)

    def test_a_rejected_candidate_uploads_only_its_card(self):
        v = self.cyc.next_version(self.cyc.require_manifest())
        self.assertEqual(v, "v2")
        make_candidate(self.cyc, "20261121-2200", v, "v1", passed=False)
        n = len(self.s3.calls)
        r = publish(self.cyc, "20261121-2200")
        self.assertEqual(r["result"], "rejected")
        self.assertEqual(self.puts(n), [(self.M, "cards/v2.json")])
        card = self.s3.json(self.M, "cards/v2.json")
        self.assertEqual((card["result"], card["parent"], card["cycleId"]), ("rejected", "v1", "20261121-2200"))
        self.assertIn("no gain", card["reason"])
        # The number is taken: the next candidate is v3 although the manifest never held v2.
        self.assertEqual(self.cyc.next_version(self.cyc.require_manifest()), "v3")

    def test_promotion_order_window_and_refusal(self):
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261121-2200", v, "v1", passed=True)
        n = len(self.s3.calls)
        r = publish(self.cyc, "20261121-2200")
        self.assertEqual(r["result"], "promoted")
        self.assertEqual(self.puts(n), [(self.M, "models/v2.zapw"), (self.M, "cards/v2.json"), (self.M, "manifest.json"), (self.P, "summary.json"), (self.M, "status/training.json")])
        m = self.s3.json(self.M, "manifest.json")
        self.assertEqual((m["current"], m["control"], m["controlUntil"]), ("v2", "v1", T0 + 14 * DAY))
        self.assertEqual(self.s3.buckets[self.P]["summary.json"]["cache"], "public, max-age=300")
        summary = self.s3.json(self.P, "summary.json")
        formats.check("zap-summary/1", summary)
        self.assertEqual([(x["version"], x["result"], x["anchors"] is None) for x in summary["versions"]], [("v1", "bootstrap", True), ("v2", "promoted", False)])
        self.assertEqual(summary["training"]["nextAfter"], T0 + 14 * DAY)
        status = self.s3.json(self.M, "status/training.json")
        self.assertEqual(status["lastPromotion"], {"version": "v2", "at": T0})
        st = load_state(self.cfg.data_dir)
        self.assertEqual(st["ab"]["control"], "v1")
        self.assertTrue((self.cfg.data_dir / "versions" / "v2" / "snapshot.zapw").exists())
        # A second promotion inside the window is refused by a guard (exit code 2).
        v3 = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261122-2200", v3, "v2", passed=True)
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, "20261122-2200")
        self.assertEqual(e.exception.exit_code, 2)

    def test_no_promotion_after_the_window_ended_until_the_ab_check_closed_it(self):
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261121-2200", v, "v1", passed=True)
        publish(self.cyc, "20261121-2200")
        self.clock.t = T0 + 14 * DAY + 60_000
        v3 = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261206-2200", v3, "v2", passed=True)
        with self.assertRaises(GuardError) as e:
            publish(self.cyc, "20261206-2200")
        self.assertIn("not closed yet; run ab first", str(e.exception))
        with self.assertRaises(GuardError):
            cmd_run(self.cyc, None)
        recs = self.tmp / "none.jsonl"
        recs.write_text("")
        self.assertEqual(run_ab(self.cyc, recs)["action"], "close")
        self.assertEqual(self.s3.json(self.M, "cards/v2.json")["ab"]["rolledBack"], False)
        self.assertEqual(publish(self.cyc, "20261206-2200")["result"], "promoted")

    def test_rollback(self):
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261121-2200", v, "v1", passed=True)
        publish(self.cyc, "20261121-2200")
        self.clock.t += DAY
        n = len(self.s3.calls)
        rollback(self.cyc, "v1")
        self.assertEqual(self.puts(n), [(self.M, "manifest.json"), (self.M, "cards/v2.json"), (self.P, "summary.json"), (self.M, "status/training.json")])
        m = self.s3.json(self.M, "manifest.json")
        self.assertEqual((m["current"], m["control"], m["controlUntil"]), ("v1", None, None))
        self.assertIn("v2", m["models"])
        self.assertEqual(self.s3.json(self.M, "cards/v2.json")["result"], "rolled-back")
        self.assertIsNone(load_state(self.cfg.data_dir)["ab"])
        with self.assertRaises(CycleError):
            rollback(self.cyc, "v9")

    def test_ab_rolls_back_a_weaker_version_automatically(self):
        self.cyc.state["lastAbNote"] = {"version": "v1", "control": "v0", "at": T0 - DAY, "note": "The automatic rollback could not decide: too few people played."}
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261121-2200", v, "v1", passed=True)
        publish(self.cyc, "20261121-2200")
        recs = self.tmp / "records.jsonl"
        lines = []
        for i in range(600):
            arm = "control" if i % 2 else "candidate"
            k = i // 2
            ai_wins = (k % 10) < (6 if arm == "control" else 4)
            lines.append(json.dumps({"key": f"k{i}", "kind": "solo2", "test": True, "arm": arm, "endedAt": T0 + 1000 + i, "winner": 1 if ai_wins else 0, "humans": [{"seat": 0, "group": f"{i % 50:016x}", "weight": 1, "flagged": False, "openDataOptOut": False, "abandoned": False}]}))
        recs.write_text("\n".join(lines) + "\n")
        self.clock.t = T0 + 3 * DAY
        out = run_ab(self.cyc, recs)
        self.assertEqual(out["action"], "rollback")
        m = self.s3.json(self.M, "manifest.json")
        self.assertEqual((m["current"], m["control"]), ("v1", None))
        card = self.s3.json(self.M, "cards/v2.json")
        self.assertEqual(card["result"], "rolled-back")
        self.assertTrue(card["ab"]["rolledBack"])
        self.assertEqual(card["ab"]["matches"], {"candidate": 300, "control": 300})
        self.assertIn("rolled back", self.s3.json(self.M, "status/training.json")["message"])
        self.assertEqual(load_state(self.cfg.data_dir)["lastAbCheckDate"], "2026-11-25")
        self.assertIsNone(load_state(self.cfg.data_dir)["lastAbNote"], "the check decided this window")

    def test_ab_closes_the_window_at_its_end(self):
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261121-2200", v, "v1", passed=True)
        publish(self.cyc, "20261121-2200")
        recs = self.tmp / "none.jsonl"
        recs.write_text("")
        self.clock.t = T0 + 2 * DAY
        self.assertEqual(run_ab(self.cyc, recs)["action"], "continue")
        self.clock.t = T0 + 14 * DAY
        self.assertEqual(run_ab(self.cyc, recs)["action"], "close")
        m = self.s3.json(self.M, "manifest.json")
        self.assertEqual((m["current"], m["control"], m["controlUntil"]), ("v2", None, None))
        card = self.s3.json(self.M, "cards/v2.json")
        self.assertEqual(card["result"], "promoted")
        self.assertFalse(card["ab"]["rolledBack"])
        formats.check("zap-summary/1", self.s3.json(self.P, "summary.json"))

    def test_one_person_cannot_roll_back_and_the_close_says_so(self):
        # One person, 600 matches, beating the new version far more often: the rule of matches
        # alone rolled back on this; with too few people the window runs to its end, closes with
        # v2 in place, and the status says the automatic rollback could not decide.
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261121-2200", v, "v1", passed=True)
        publish(self.cyc, "20261121-2200")
        recs = self.tmp / "one-person.jsonl"
        lines = []
        for i in range(600):
            arm = "control" if i % 2 else "candidate"
            ai_wins = (i // 2) % 10 < (8 if arm == "control" else 2)
            lines.append(json.dumps({"key": f"k{i}", "kind": "solo1", "test": True, "arm": arm, "endedAt": T0 + 1000 + i, "winner": 1 if ai_wins else 0, "humans": [{"seat": 0, "group": "a" * 16, "weight": 1, "flagged": False, "openDataOptOut": False, "abandoned": False}]}))
        recs.write_text("\n".join(lines) + "\n")
        self.clock.t = T0 + 3 * DAY
        out = run_ab(self.cyc, recs)
        self.assertEqual(out["action"], "continue")
        self.assertEqual(out["result"]["armPeople"], {"candidate": 1, "control": 1})
        self.clock.t = T0 + 14 * DAY
        out = run_ab(self.cyc, recs)
        self.assertEqual(out["action"], "close")
        self.assertIn("too few people played (1 with v2, 1 with v1; it needs 20 in each group)", out["undecided"])
        m = self.s3.json(self.M, "manifest.json")
        self.assertEqual((m["current"], m["control"]), ("v2", None))
        card = self.s3.json(self.M, "cards/v2.json")
        self.assertEqual(card["result"], "promoted")
        self.assertFalse(card["ab"]["rolledBack"])
        self.assertIsNone(card["ab"]["drop"], "no comparison on the card below 20 people in each arm")
        status = self.s3.json(self.M, "status/training.json")
        self.assertTrue(status["message"].startswith("A/B window of v2 against v1 closed; v2 stays. The automatic rollback could not decide: too few people played"), status["message"])
        self.assertIn("Only a rollback by hand (rollback v1) brings v1 back.", status["message"])
        self.assertEqual((status["state"], status["step"]), ("ok", "idle"))
        # The cycle the same scheduler tick starts replaces that message at its first step; the note
        # stays in state.json, which `status` prints, until the next window ends.
        self.cyc.write_status("running", "sync", "Cycle 20261206-1200: step sync.", cycle_id="20261206-1200", started_at=self.clock.t)
        note = {"version": "v2", "control": "v1", "at": T0 + 14 * DAY, "note": out["undecided"]}
        self.assertEqual(cmd_status(self.cyc)["state"]["lastAbNote"], note)
        self.assertEqual(load_state(self.cfg.data_dir)["lastAbNote"], note)
        rollback(self.cyc, "v1")
        self.assertEqual(load_state(self.cfg.data_dir)["lastAbNote"], note, "a rollback by hand leaves it")

    def test_a_close_that_could_decide_clears_the_note(self):
        self.cyc.state["lastAbNote"] = {"version": "v1", "control": "v0", "at": T0 - DAY, "note": "The automatic rollback could not decide: too few people played."}
        self.cyc.state.save()
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261121-2200", v, "v1", passed=True)
        publish(self.cyc, "20261121-2200")
        recs = self.tmp / "even.jsonl"
        lines = []
        for i in range(600):
            arm = "control" if i % 2 else "candidate"
            lines.append(json.dumps({"key": f"k{i}", "kind": "solo1", "test": True, "arm": arm, "endedAt": T0 + 1000 + i, "winner": 1 if (i // 2) % 10 < 5 else 0, "humans": [{"seat": 0, "group": f"{i % 50:016x}", "weight": 1, "flagged": False, "openDataOptOut": False, "abandoned": False}]}))
        recs.write_text("\n".join(lines) + "\n")
        self.clock.t = T0 + 14 * DAY
        out = run_ab(self.cyc, recs)
        self.assertEqual(out["action"], "close")
        self.assertNotIn("undecided", out)
        self.assertEqual(self.s3.json(self.M, "status/training.json")["message"], "A/B window of v2 against v1 closed; v2 stays.")
        self.assertIsNone(load_state(self.cfg.data_dir)["lastAbNote"])


class InitBundleTest(unittest.TestCase):
    """prod lists both bundled models: init uploads v1 and v2 with their cards, v2 current."""

    def setUp(self):
        self.cfg, self.tmp = temp_config("test", storage={"bundled": ["v1", "v2"]})
        self.cyc, self.s3 = fake_cycle(self.cfg, clock=Clock())
        self.M = self.cfg.storage["models_bucket"]

    def test_init_uploads_every_bundled_version_with_the_last_current(self):
        from zapcycle.config import ROOT
        from zapcycle.gate import panel

        r = init(self.cyc)
        self.assertEqual((r["manifest"], r["versions"]), ("v2", ["v1", "v2"]))
        puts = [(b, k) for op, b, k in self.s3.calls if op == "put"]
        self.assertEqual(puts, [(self.M, "models/v1.zapw"), (self.M, "cards/v1.json"), (self.M, "models/v2.zapw"), (self.M, "cards/v2.json"), (self.M, "manifest.json"), (self.M, "status/training.json")])
        m = self.s3.json(self.M, "manifest.json")
        formats.check("zap-manifest/1", m)
        self.assertEqual((m["current"], m["control"], m["controlUntil"]), ("v2", None, None))
        bundled = json.loads((ROOT / "ai/models/bootstrap/manifest-v2.json").read_text())
        e = m["models"]["v2"]
        self.assertEqual((e["sha256"], e["bytes"], e["features"], e["adapt"]), (bundled["sha256"], bundled["bytes"], bundled["features"], bundled.get("adapt")))
        self.assertEqual(e["personas"], bundled["personas"])
        self.assertEqual(self.s3.json(self.M, "cards/v1.json")["result"], "bootstrap")
        card = self.s3.json(self.M, "cards/v2.json")
        self.assertEqual((card["result"], card["parent"], card["gate"]["pass"]), ("promoted", "v1", True))
        self.assertIn("v2 current", self.s3.json(self.M, "status/training.json")["message"])
        for v in ("v1", "v2"):
            self.assertTrue((self.cfg.data_dir / "versions" / v / "model.zapw").exists())
        # The bundled file is never read back from the bucket, and v2 joins the panel and the league.
        n = len(self.s3.calls)
        self.cyc.ensure_version("v2", e)
        self.assertEqual([c for c in self.s3.calls[n:] if c[0] == "get"], [])
        self.assertIn("v2", [p["member"] for p in panel(self.cyc, m)])
        self.assertEqual(self.cyc.next_version(m), "v3")
        self.assertFalse(init(self.cyc)["initialized"])

    def test_a_version_outside_the_bundle_is_refused(self):
        from zapcycle.errors import CycleError as Err

        cfg, _ = temp_config("test", storage={"bundled": ["v1", "v9"]})
        cyc, _ = fake_cycle(cfg, clock=Clock())
        with self.assertRaises(Err):
            init(cyc)
