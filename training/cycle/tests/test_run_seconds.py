"""run_seconds (zapcycle/publish.py): the training time of an adopted run over the whole chain of
runs it resumed from (train.py --resume-from)."""

import json
import tempfile
import unittest
from pathlib import Path

from zapcycle.core import write_json
from zapcycle.errors import CycleError
from zapcycle.publish import run_seconds


def metrics(run: Path, lines: list[tuple[int, float]]) -> None:
    run.mkdir(parents=True, exist_ok=True)
    (run / "metrics.jsonl").write_text("".join(json.dumps({"iteration": i, "selfplay_seconds": s, "learn_seconds": 1.0, "eval_seconds": 0.5}) + "\n" for i, s in lines))


class RunSecondsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        # base: iterations 0 to 9 (10 + 1 + 0.5 each); fine: resumed at 6 from base's checkpoint of
        # iteration 5, iterations 6 to 11 (20 + 1 + 0.5 each), iteration 8 logged twice.
        self.base = self.tmp / "m6-adaptive"
        metrics(self.base, [(i, 10.0) for i in range(10)])
        write_json(self.base / "args.json", {"resume_from": None})
        self.fine = self.tmp / "m6-adaptive-r"
        metrics(self.fine, [(6, 20.0), (7, 20.0), (8, 99.0), (8, 20.0), (9, 20.0), (10, 20.0), (11, 20.0)])
        write_json(self.fine / "args.json", {"resume_from": str(self.base)})
        write_json(self.fine / "resumed-from.json", {"from": str(self.base), "checkpoint": {"iteration": 5}})

    def test_one_run(self):
        self.assertEqual(run_seconds(self.base, 10), 115.0)
        self.assertEqual(run_seconds(self.base, 4), 46.0)

    def test_the_chain_counts_every_run_up_to_the_snapshot(self):
        # Snapshot it000012: fine 6 to 11 (6 x 21.5) and base 0 to 5 (6 x 11.5); base's 6 to 9 were
        # replaced by the fine-tune and do not count.
        self.assertEqual(run_seconds(self.fine, 12), 198.0)
        # Snapshot it000009: fine 6 to 8, base 0 to 5.
        self.assertEqual(run_seconds(self.fine, 9), 133.5)

    def test_without_resumed_from_json_the_first_logged_iteration_marks_the_resume(self):
        (self.fine / "resumed-from.json").unlink()
        self.assertEqual(run_seconds(self.fine, 12), 198.0)

    def test_a_missing_run_of_the_chain_is_an_error(self):
        (self.base / "metrics.jsonl").unlink()
        with self.assertRaises(CycleError) as e:
            run_seconds(self.fine, 12)
        self.assertIn("m6-adaptive/metrics.jsonl", str(e.exception))
        metrics(self.base, [(0, 1.0)])
        (self.base / "args.json").unlink()
        with self.assertRaises(CycleError) as e:
            run_seconds(self.fine, 12)
        self.assertIn("args.json", str(e.exception))

    def test_a_loop_is_an_error(self):
        write_json(self.base / "args.json", {"resume_from": str(self.fine)})
        with self.assertRaises(CycleError):
            run_seconds(self.fine, 12)

    def test_no_metrics_or_no_iteration(self):
        self.assertEqual(run_seconds(self.tmp / "nothing", 5), 0)
        self.assertEqual(run_seconds(self.fine, None), 0)
