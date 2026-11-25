"""The remote status around a step run on its own (cli.one_step): running while it runs; when it ends
ok, the status from before it comes back (ok stays ok, failed stays failed), unless the step wrote a
final status itself (publish, adopt); a failure still marks it failed."""

import argparse
import unittest
from datetime import datetime, timezone
from unittest import mock

from zapcycle import cli
from zapcycle.publish import init, keep_status, publish
from zapcycle.summary import build_summary

from .helpers import fake_cycle, temp_config
from .samples import make_candidate

T0 = int(datetime(2026, 11, 24, 17, 41, tzinfo=timezone.utc).timestamp() * 1000)
MINUTE = 60_000
PROMOTION = {"version": "v2", "at": T0 - 2 * 86_400_000}


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


class StepStatusTest(unittest.TestCase):
    def setUp(self):
        self.cfg, self.tmp = temp_config("test")
        self.clock = Clock()
        self.cyc, self.s3 = fake_cycle(self.cfg, clock=self.clock)
        self.M = self.cfg.storage["models_bucket"]

    def status(self) -> dict:
        return self.s3.json(self.M, "status/training.json")

    def previous(self, state: str = "ok", step: str = "idle", message: str = "v2 promoted; A/B window with v1 until the window closes.") -> dict:
        self.clock.t = T0 - 10 * MINUTE
        self.cyc.write_status(state, step, message, cycle_id="20261121-2200", started_at=T0 - 30 * MINUTE, finished_at=T0 - 10 * MINUTE, last_promotion=PROMOTION, keep_failed=False)
        before = self.status()
        self.clock.t = T0
        return before

    def sync(self, inside=None) -> dict:
        """The sync command as dispatch runs it, with the sync itself replaced; `inside` sees the
        status while the step runs."""

        def fake(cyc):
            if inside:
                inside(self.status())
            self.clock.t += 5 * MINUTE
            return {"exports": 0}

        with mock.patch.object(cli, "do_sync", fake):
            return cli.dispatch(argparse.Namespace(cmd="sync"), self.cfg, self.cyc)

    def assert_restored(self, before: dict) -> None:
        after = self.status()
        self.assertEqual({k: v for k, v in after.items() if k != "updatedAt"}, {k: v for k, v in before.items() if k != "updatedAt"})
        self.assertEqual(after["updatedAt"], self.clock.t, "a fresh updatedAt")

    def test_sync_that_ends_ok_puts_the_ok_status_back(self):
        before = self.previous()
        seen = []
        self.assertEqual(self.sync(seen.append), {"exports": 0})
        self.assertEqual((seen[0]["state"], seen[0]["step"], seen[0]["cycleId"]), ("running", "sync", cli.new_cycle_id(T0)))
        self.assert_restored(before)
        self.assertEqual((self.status()["state"], self.status()["step"]), ("ok", "idle"))

    def test_a_failed_status_stays_failed(self):
        before = self.previous("failed", "train", "Cycle 20261121-2200 failed at step train: boom")
        seen = []
        self.sync(seen.append)
        self.assertEqual((seen[0]["state"], seen[0]["step"]), ("failed", "sync"), "a failed state stays while a step runs")
        self.assert_restored(before)
        self.assertEqual(self.status()["message"], "Cycle 20261121-2200 failed at step train: boom")

    def test_without_a_status_before_or_with_a_stale_running_one_it_ends_ok_and_idle(self):
        self.sync()
        s = self.status()
        self.assertEqual((s["state"], s["step"], s["message"]), ("ok", "idle", "Step sync ended ok; no cycle runs."))
        # summary.json shows finishedAt as the last training: a step is none, so it stays null.
        self.assertIsNone(s["finishedAt"])
        # The status a sync of an older version left behind: running, though nothing runs.
        self.previous("running", "sync", "Cycle 20261124-1741: step sync.")
        self.sync()
        s = self.status()
        self.assertEqual((s["state"], s["step"], s["message"], s["lastPromotion"]), ("ok", "idle", "Step sync ended ok; no cycle runs.", PROMOTION))
        self.assertEqual(s["finishedAt"], T0 - 10 * MINUTE, "the end of the last cycle stays")
        self.assertEqual(build_summary(self.cyc, {"current": "v2", "control": None, "models": {}}, s)["training"]["finishedAt"], T0 - 10 * MINUTE)

    def test_a_failure_still_marks_the_step_failed(self):
        self.previous()

        def broken(cyc):
            raise RuntimeError("no route to the bucket")

        with mock.patch.object(cli, "do_sync", broken), self.assertRaises(RuntimeError):
            cli.dispatch(argparse.Namespace(cmd="sync"), self.cfg, self.cyc)
        s = self.status()
        self.assertEqual((s["state"], s["step"]), ("failed", "sync"))
        self.assertIn("no route to the bucket", s["message"])

    def test_a_status_that_cannot_be_read_before_the_step_fails_that_step(self):
        self.previous()
        real = self.cyc.read_status
        calls = []

        def first_read_times_out():
            calls.append(1)
            if len(calls) == 1:
                raise ConnectionError("read timed out")
            return real()

        with mock.patch.object(self.cyc, "read_status", first_read_times_out), self.assertRaises(ConnectionError):
            self.sync()
        s = self.status()
        self.assertEqual((s["state"], s["step"]), ("failed", "sync"))
        self.assertEqual(s["message"], f"Cycle {cli.new_cycle_id(T0)} failed at step sync: read timed out")

    def test_a_long_step_with_heartbeats_and_the_explorer_step(self):
        before = self.previous()
        self.cfg.work_dir.mkdir(parents=True, exist_ok=True)
        cid = "20261124-1700"

        def train(st):
            self.clock.t += 30 * MINUTE
            st.heartbeat()
            self.assertEqual(self.status()["message"], f"Cycle {cid}: still at step train.")
            self.clock.t += 30 * MINUTE
            return {"version": "v3"}

        self.assertEqual(cli.one_step(self.cyc, cid, "train", train), {"version": "v3"})
        self.assert_restored(before)

        def explorer(st):
            st.status("gate", f"Cycle {st.cycle_id}: step gate, explorer test.")
            self.clock.t += MINUTE
            return {"applies": False}

        cli.one_step(self.cyc, cid, "gate", explorer)
        self.assert_restored(before)

    def test_a_heartbeat_that_landed_and_still_raised(self):
        # proc.run swallows a failed heartbeat; its status may have landed all the same.
        before = self.previous()
        real = self.cyc.write_status

        def landed_then_raised(*a, **k):
            real(*a, **k)
            raise ConnectionError("timeout after the write")

        def train(st):
            self.clock.t += 30 * MINUTE
            with mock.patch.object(self.cyc, "write_status", landed_then_raised), self.assertRaises(ConnectionError):
                st.heartbeat()
            self.assertEqual(self.status()["message"], f"Cycle {st.cycle_id}: still at step train.")
            return {}

        cli.one_step(self.cyc, "20261124-1700", "train", train)
        self.assert_restored(before)

    def test_a_rollback_by_hand_during_a_step_keeps_its_message(self):
        before = self.previous()

        def rolled_back(cyc):
            keep_status(cyc, "Rolled back from v2 to v1.")
            return {"exports": 0}

        with mock.patch.object(cli, "do_sync", rolled_back):
            cli.dispatch(argparse.Namespace(cmd="sync"), self.cfg, self.cyc)
        s = self.status()
        self.assertEqual((s["state"], s["step"], s["cycleId"], s["lastPromotion"]), (before["state"], before["step"], before["cycleId"], PROMOTION))
        self.assertEqual(s["message"], "Rolled back from v2 to v1.")


class FinalStatusTest(unittest.TestCase):
    """publish and adopt end with the status their publication writes: it stays."""

    def setUp(self):
        self.cfg, self.tmp = temp_config("test")
        self.clock = Clock()
        self.cyc, self.s3 = fake_cycle(self.cfg, clock=self.clock)
        self.M = self.cfg.storage["models_bucket"]
        init(self.cyc)

    def test_a_promotion_keeps_its_status(self):
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261124-1700", v, "v1", passed=True)
        out = cli.one_step(self.cyc, "20261124-1700", "publish", lambda st: publish(self.cyc, st.cycle_id))
        self.assertEqual(out["result"], "promoted")
        s = self.s3.json(self.M, "status/training.json")
        self.assertEqual((s["state"], s["step"], s["lastPromotion"]["version"]), ("ok", "idle", v))
        self.assertTrue(s["message"].startswith(f"{v} promoted"), s["message"])

    def test_a_rejection_keeps_its_status(self):
        v = self.cyc.next_version(self.cyc.require_manifest())
        make_candidate(self.cyc, "20261124-1700", v, "v1", passed=False)
        out = cli.one_step(self.cyc, "20261124-1700", "publish", lambda st: cli.finish_ok(self.cyc, st, publish(self.cyc, st.cycle_id)))
        self.assertEqual(out["result"], "rejected")
        s = self.s3.json(self.M, "status/training.json")
        self.assertEqual((s["state"], s["step"]), ("ok", "idle"))
        self.assertTrue(s["message"].startswith(f"Cycle 20261124-1700 ended: {v} rejected."), s["message"])


if __name__ == "__main__":
    unittest.main()
