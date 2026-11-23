import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from zapcycle.errors import LockBusy
from zapcycle.lock import FileLock, cycle_lock, lock_holder


class LockTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_one_holder_at_a_time(self):
        with cycle_lock(self.dir, "20261121-2200", 123):
            holder = lock_holder(self.dir / "locks" / "cycle.lock")
            self.assertEqual(holder["cycleId"], "20261121-2200")
            self.assertEqual(holder["startedAt"], 123)
            with self.assertRaises(LockBusy) as e:
                cycle_lock(self.dir, "other", 1).acquire()
            self.assertEqual(e.exception.exit_code, 3)
            self.assertIn("20261121-2200", str(e.exception))
        self.assertIsNone(lock_holder(self.dir / "locks" / "cycle.lock"))
        with cycle_lock(self.dir, "next", 2):
            pass

    def test_waiting_lock_gives_up_after_its_time(self):
        path = self.dir / "m.lock"
        with FileLock(path):
            t0 = time.monotonic()
            with self.assertRaises(LockBusy):
                FileLock(path, wait_s=0.5, poll_s=0.1).acquire()
            self.assertGreaterEqual(time.monotonic() - t0, 0.45)

    def test_a_dead_holder_frees_the_lock(self):
        path = self.dir / "locks" / "cycle.lock"
        code = (
            "import sys, time; sys.path.insert(0, 'training/cycle');"
            "from zapcycle.lock import cycle_lock; from pathlib import Path;"
            f"l = cycle_lock(Path({str(self.dir)!r}), 'child', 1).acquire(); print('held', flush=True); time.sleep(60)"
        )
        p = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(p.stdout.readline().strip(), "held")
            self.assertEqual(lock_holder(path)["cycleId"], "child")
            p.kill()
            p.wait()
            self.assertIsNone(lock_holder(path))
            with cycle_lock(self.dir, "after", 2):
                self.assertEqual(json.loads(path.read_text())["cycleId"], "after")
        finally:
            p.kill()
            p.wait()
            p.stdout.close()
