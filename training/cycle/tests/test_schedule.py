import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from zapcycle.config import ROOT
from zapcycle.lock import cycle_lock
from zapcycle.scheduler import Scheduler, ab_due, latest_slot, ms, run_with_deadline
from zapcycle.state import load_state

from .helpers import CONFIG_DIR, temp_config

UTC = timezone.utc
SAT_SLOT = datetime(2026, 11, 22, 1, 0, tzinfo=UTC)  # Saturday 21 November 2026, 22:00 in São Paulo


def at(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=UTC)


class SlotTest(unittest.TestCase):
    def test_latest_weekly_slot(self):
        self.assertEqual(latest_slot(at("2026-11-22T01:00:00"), 5, "22:00", "America/Sao_Paulo"), SAT_SLOT)
        self.assertEqual(latest_slot(at("2026-11-22T00:59:00"), 5, "22:00", "America/Sao_Paulo"), SAT_SLOT - timedelta(days=7))
        self.assertEqual(latest_slot(at("2026-11-25T12:00:00"), 5, "22:00", "America/Sao_Paulo"), SAT_SLOT)

    def test_ab_check_once_a_day_after_its_time(self):
        self.assertFalse(ab_due(at("2026-11-22T05:59:00"), "06:00", None))
        self.assertTrue(ab_due(at("2026-11-22T06:00:00"), "06:00", "2026-11-21"))
        self.assertFalse(ab_due(at("2026-11-22T18:00:00"), "06:00", "2026-11-22"))


class Runner:
    def __init__(self, data_dir: Path, result=None, closes=True):
        self.cmds = []
        self.data_dir = data_dir
        self.result = result or {"returncode": 0, "killed": False}
        self.closes = closes  # whether the ab command closes an ended window, as run_ab does

    def __call__(self, cmd, limit):
        self.cmds.append((cmd[-1], limit))
        if cmd[-1] == "run":
            st = load_state(self.data_dir)
            st["lastCycleStartedAt"] = self.now
            st.save()
        if cmd[-1] == "ab":
            st = load_state(self.data_dir)
            st["lastAbCheckDate"] = datetime.fromtimestamp(self.now / 1000, UTC).date().isoformat()
            if self.closes and st.get("ab") and self.now >= st["ab"]["until"]:
                st["ab"] = None
            st.save()
        return self.result


class SchedulerTest(unittest.TestCase):
    def make(self, lister=lambda now: 0, result=None, failed=None, closes=True):
        cfg, tmp = temp_config("test")
        runner = Runner(cfg.data_dir, result, closes)
        out: list[str] = []
        s = Scheduler(cfg, "cfg.toml", dry_run=False, out=out.append, lister=lister, run_cmd=runner, status_failed=failed)
        orig = s.tick

        def tick(i, now):
            runner.now = int(now.timestamp() * 1000)
            return orig(i, now)

        s.tick = tick
        return s, runner, out, cfg

    def test_one_cycle_at_the_weekly_slot_and_one_ab_check_a_day(self):
        s, runner, out, _ = self.make()
        d = s.loop(at("2026-11-20T12:00:00"), ticks=6 * 24 * 3, advance=600)
        cycles = [x for x in d if x["action"] == "cycle"]
        self.assertEqual(len(cycles), 1)
        self.assertEqual(cycles[0]["at"], "2026-11-22T01:00:00Z")
        self.assertEqual(sum(1 for c in runner.cmds if c[0] == "run"), 1)
        self.assertEqual(runner.cmds[[c[0] for c in runner.cmds].index("run")][1], 36 * 3600)
        ab = [x["at"][:10] for x in d if x["action"] == "ab"]
        self.assertEqual(ab, ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"])
        self.assertTrue(all(json.loads(line)["action"] for line in out))

    def test_a_missed_slot_runs_once_at_the_next_tick(self):
        s, runner, _, cfg = self.make()
        st = load_state(cfg.data_dir)
        st["lastCycleStartedAt"] = int(at("2026-11-14T01:00:00").timestamp() * 1000)
        st["lastAbCheckDate"] = "2026-11-25"
        st.save()
        d = s.loop(at("2026-11-25T12:00:00"), ticks=30, advance=600)
        self.assertEqual([x["tick"] for x in d if x["action"] == "cycle"], [0])

    def test_nothing_while_the_cycle_lock_is_held(self):
        s, runner, _, cfg = self.make()
        with cycle_lock(cfg.data_dir, "20261122-0100", 1):
            d = s.loop(at("2026-11-22T02:00:00"), ticks=3, advance=600)
        self.assertEqual({x["action"] for x in d}, {"wait"})
        self.assertEqual(runner.cmds, [])

    def test_no_cycle_while_an_ab_window_is_open(self):
        s, runner, _, cfg = self.make()
        st = load_state(cfg.data_dir)
        st["ab"] = {"version": "v2", "control": "v1", "from": 0, "until": int(at("2026-11-30T00:00:00").timestamp() * 1000)}
        st["lastAbCheckDate"] = "2026-11-22"
        st.save()
        d = s.loop(at("2026-11-22T02:00:00"), ticks=5, advance=600)
        self.assertNotIn("cycle", {x["action"] for x in d})
        self.assertIn("A/B window open", d[0]["reason"])

    def ended_window(self, cfg, until: datetime) -> None:
        st = load_state(cfg.data_dir)
        st["ab"] = {"version": "v2", "control": "v1", "from": ms(until - timedelta(days=14)), "until": ms(until)}
        st["lastCycleStartedAt"] = ms(at("2026-11-29T01:00:00"))
        st["lastAbCheckDate"] = until.date().isoformat()  # the daily check already ran that morning
        st.save()

    def test_an_ended_window_is_closed_before_any_cycle(self):
        # Published at 13:00 UTC after a weekly cycle: the window ends at 13:00 UTC, long after the
        # daily check of 06:00 and after that day's weekly slot (01:00 UTC).
        until = at("2026-12-13T13:00:00")
        s, runner, _, cfg = self.make()
        self.ended_window(cfg, until)
        d = s.loop(until + timedelta(minutes=1), ticks=2, advance=600)
        self.assertEqual(d[0]["action"], "ab")
        self.assertIn("final check and close", d[0]["reason"])
        self.assertEqual([c[0] for c in runner.cmds], ["ab", "run"])
        self.assertEqual([x["action"] for x in d], ["ab", "cycle", "idle"])
        self.assertIsNone(load_state(cfg.data_dir)["ab"])

    def test_no_cycle_while_an_ended_window_fails_to_close(self):
        until = at("2026-12-13T13:00:00")
        s, runner, _, cfg = self.make(closes=False)
        self.ended_window(cfg, until)
        d = s.loop(until + timedelta(minutes=1), ticks=3, advance=600)
        self.assertNotIn("cycle", [x["action"] for x in d])
        self.assertEqual([c[0] for c in runner.cmds], ["ab", "ab", "ab"])
        self.assertIn("not closed yet", d[1]["reason"])

    def test_dry_run_closes_an_ended_window_in_memory(self):
        until = at("2026-12-13T13:00:00")
        cfg, _ = temp_config("test")
        self.ended_window(cfg, until)
        out: list[str] = []
        s = Scheduler(cfg, "cfg.toml", dry_run=True, out=out.append, lister=lambda now: 0)
        d = s.loop(until - timedelta(minutes=20), ticks=3, advance=600)
        self.assertEqual([x["action"] for x in d], ["idle", "idle", "ab", "cycle"])
        self.assertIsNotNone(load_state(cfg.data_dir)["ab"], "a dry run changes nothing on disk")

    def test_new_matches_start_a_cycle_and_listing_is_hourly(self):
        calls = []

        def lister(now):
            calls.append(now)
            return 1200 if len(calls) == 3 else 10

        s, runner, _, cfg = self.make(lister=lister)
        st = load_state(cfg.data_dir)
        st["lastCycleStartedAt"] = int(at("2026-11-23T00:00:00").timestamp() * 1000)
        st["lastAbCheckDate"] = "2026-11-23"
        st.save()
        d = s.loop(at("2026-11-23T08:00:00"), ticks=13, advance=600)
        self.assertEqual(len(calls), 3)
        self.assertEqual([x["reason"] for x in d if x["action"] == "cycle"], ["1200 new matches"])
        self.assertEqual(sum(1 for c in runner.cmds if c[0] == "run"), 1)

    def test_a_killed_cycle_marks_the_status_failed(self):
        msgs = []
        s, runner, _, cfg = self.make(result={"returncode": -15, "killed": True}, failed=msgs.append)
        st = load_state(cfg.data_dir)
        st["lastAbCheckDate"] = "2026-11-22"
        st["lastCycleStartedAt"] = int(at("2026-11-15T01:00:00").timestamp() * 1000)
        st.save()
        d = s.loop(at("2026-11-22T02:00:00"), ticks=1, advance=600)
        self.assertIn("killed", [x["action"] for x in d])
        self.assertEqual(len(msgs), 1)
        self.assertIn("time limit", msgs[0])


class DeadlineTest(unittest.TestCase):
    def test_the_36_hour_limit_kills_the_process_group(self):
        clock = {"t": 0.0}
        p = subprocess.Popen(["sh", "-c", "sleep 300 & sleep 300; wait"], start_new_session=True)
        try:
            r = run_with_deadline(["x"], 36 * 3600, lambda: clock["t"], lambda s: clock.__setitem__("t", clock["t"] + 3600), popen=lambda c: p)
            self.assertTrue(r["killed"])
            self.assertEqual(r["seconds"], 36 * 3600)
            self.assertIsNotNone(p.poll())
        finally:
            p.kill()
            p.wait()

    def test_a_cycle_that_ends_in_time(self):
        r = run_with_deadline(["true"], 36 * 3600, __import__("time").time, lambda s: __import__("time").sleep(0.05), popen=lambda c: subprocess.Popen(c), poll_s=0.05)
        self.assertEqual((r["returncode"], r["killed"]), (0, False))


class DryRunCliTest(unittest.TestCase):
    def test_dry_run_prints_one_line_per_decision(self):
        tmp = Path(tempfile.mkdtemp())
        text = (CONFIG_DIR / "test.toml").read_text()
        text = text.replace('data = "training/cycle/data/test"', f'data = "{tmp}/data"').replace('work = "training/cycle/work/test"', f'work = "{tmp}/work"').replace('logs = "training/logs/test"', f'logs = "{tmp}/logs"')
        cfg = tmp / "c.toml"
        cfg.write_text(text)
        r = subprocess.run([sys.executable, str(ROOT / "training/cycle/cycle.py"), "--config", str(cfg), "scheduler", "--now", "2026-11-21T20:00:00Z", "--ticks", "36", "--tick-advance", "600", "--dry-run"], capture_output=True, text=True, cwd=ROOT, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = [json.loads(line) for line in r.stdout.splitlines() if line.startswith('{"tick"')]
        self.assertEqual(len({x["tick"] for x in lines}), 36)
        self.assertEqual([x["at"] for x in lines if x["action"] == "cycle"], ["2026-11-22T01:00:00Z"])
        self.assertFalse((tmp / "data" / "scheduler.json").exists())
        self.assertFalse((tmp / "data" / "state.json").exists())
