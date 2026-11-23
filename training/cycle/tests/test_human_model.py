"""Human behaviour model: the split by device never mixes people, the baseline and the t interval over people,
the pass rule on bet and answer decisions, the start from the self-play weights, the thresholds."""

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

from zapcycle.config import ROOT
from zapcycle.human import model

from .human_support import new_context

BET_MASK = 0b1000111  # play the three cards or raise
ANSWER_MASK = 0b111000000  # raise again, accept or run
CARD_MASK = 0b111


def dataset(groups: int, rows_per: int, learnable: bool, seed: int = 3):
    rng = np.random.default_rng(seed)
    n = groups * rows_per
    # Mostly zeros with a few bits, like the one-hot inputs of features v1.
    x = np.zeros((n, model.NUM_FEATURES), dtype=np.float32)
    x[:, :20] = rng.random((n, 20)) < 0.5
    types = rng.choice(["bet", "answer", "card"], size=n, p=[0.4, 0.4, 0.2])
    mask = np.array([{"bet": BET_MASK, "answer": ANSWER_MASK, "card": CARD_MASK}[t] for t in types], dtype=np.uint16)
    y = np.empty(n, dtype=np.uint8)
    for r, t in enumerate(types):
        legal = [a for a in range(15) if mask[r] >> a & 1]
        if learnable:
            hi = x[r, 0] > 0.5
            y[r] = {"bet": 6 if hi else 0, "answer": 7 if hi else 8, "card": 2 if hi else 0}[t]
        else:
            y[r] = rng.choice(legal)
    meta = [{"group": f"{(r // rows_per):016x}", "type": str(t), "w": 1.0} for r, t in enumerate(types)]
    return x, y, mask, meta


SETTINGS = {**model.DEFAULTS, "epochs": 6, "patience": 2, "batch": 64, "lr": 0.01, "anchor": 0.0}


def fresh(hidden: int):
    import torch

    torch.manual_seed(0)
    return model.init_state(None, [hidden])[0]


class SplitTest(unittest.TestCase):
    def test_a_person_is_only_on_one_side(self):
        groups = [f"{i:016x}" for i in range(500) for _ in range(3)]
        test = model.split(groups, 0.2)
        train_groups = {g for g, t in zip(groups, test) if not t}
        test_groups = {g for g, t in zip(groups, test) if t}
        self.assertEqual(train_groups & test_groups, set())
        self.assertGreater(len(test_groups), 60)
        self.assertLess(len(test_groups), 140)
        self.assertEqual(list(model.split(groups, 0.2)), list(test), "stable from one run to the next")

    def test_fit_and_test_reports_disjoint_groups(self):
        x, y, mask, meta = dataset(40, 30, True)
        actor = fresh(16)
        _, rep = model.fit_and_test(x, y, mask, meta, actor, SETTINGS)
        g = [m["group"] for m in meta]
        test = model.split(g, SETTINGS["test_share"])
        self.assertEqual({a for a, t in zip(g, test) if t} & {a for a, t in zip(g, test) if not t}, set())
        self.assertEqual(rep["rows"]["test"], int(test.sum()))
        self.assertEqual(sum(rep["rows"].values()), len(y))


class BaselineTest(unittest.TestCase):
    def test_add_one_frequencies_per_type_and_mask(self):
        types = ["bet"] * 4 + ["bet"]
        mask = np.array([BET_MASK] * 5, dtype=np.uint16)
        y = np.array([6, 6, 0, 1, 6], dtype=np.uint8)
        w = np.ones(5)
        train = np.array([True, True, True, True, False])
        lp = model.baseline_logp(types, mask, y, w, train)
        # counts raise 2, play0 1, play1 1, play2 0 over 4 legal actions: (2 + 1) / (4 + 4)
        self.assertAlmostEqual(float(np.exp(lp[4])), 3 / 8)
        unseen = model.baseline_logp(["answer"], np.array([ANSWER_MASK], dtype=np.uint16), np.array([7], dtype=np.uint8), np.ones(1), np.array([False]))
        self.assertAlmostEqual(float(np.exp(unseen[0])), 1 / 3)


class IntervalTest(unittest.TestCase):
    def test_student_t_over_people(self):
        # Three people, two rows each: per person means -0.3, -0.1, -0.2.
        v = np.array([-0.3, -0.3, -0.1, -0.1, -0.2, -0.2])
        g = ["a", "a", "b", "b", "c", "c"]
        r = model.interval(v, np.ones(6), g, SETTINGS)
        self.assertEqual((r["method"], r["groups"]), ("student-t", 3))
        self.assertAlmostEqual(r["mean"], -0.2)
        self.assertAlmostEqual(r["hi"], -0.2 + 4.303 * 0.1 / np.sqrt(3), places=6)
        # One group: no interval.
        self.assertIsNone(model.group_t_interval(np.array([-1.0]), np.ones(1), ["a"])["hi"])

    def test_student_t_also_from_30_test_groups(self):
        # The percentile bootstrap passed a model no better than the baseline too often from 30 test
        # people on as well (the verification's simulation): the t interval at every size.
        rng = np.random.default_rng(4)
        per = rng.normal(-0.1, 0.2, 50)
        v = np.repeat(per, 3)
        g = [f"g{i}" for i in range(50) for _ in range(3)]
        r = model.interval(v, np.ones(150), g, SETTINGS)
        self.assertEqual((r["method"], r["groups"]), ("student-t", 50))
        self.assertAlmostEqual(r["hi"], per.mean() + model.t975(49) * per.std(ddof=1) / np.sqrt(50), places=9)

    def test_t975(self):
        # Exact 0.975 quantiles of Student t (scipy.stats.t.ppf, to 4 decimals).
        for df, want in ((1, 12.706), (10, 2.228), (29, 2.045), (30, 2.0423), (49, 2.0096), (99, 1.9842), (1000, 1.9623)):
            self.assertAlmostEqual(model.t975(df), want, delta=0.0006, msg=str(df))
        self.assertGreater(model.t975(30), model.t975(31))
        self.assertLess(model.t975(30), model.T975[-1])


class PassRuleTest(unittest.TestCase):
    def test_a_learnable_style_passes(self):
        x, y, mask, meta = dataset(60, 40, True)
        actor = fresh(16)
        _, rep = model.fit_and_test(x, y, mask, meta, actor, SETTINGS)
        self.assertTrue(rep["passed"], rep)
        self.assertLess(rep["betAnswer"]["hi"], 0)
        self.assertLess(rep["bet"]["hi"], 0)
        self.assertEqual(rep["bet"]["method"], "student-t")
        for t in ("bet", "answer"):
            self.assertGreater(rep["types"][t]["model"]["accuracy"], rep["types"][t]["baseline"]["accuracy"])
            self.assertLess(rep["types"][t]["model"]["logLoss"], rep["types"][t]["baseline"]["logLoss"])

    def test_noise_does_not_pass(self):
        x, y, mask, meta = dataset(60, 40, False)
        actor = fresh(16)
        _, rep = model.fit_and_test(x, y, mask, meta, actor, SETTINGS)
        self.assertFalse(rep["passed"], rep)
        self.assertGreaterEqual(rep["betAnswer"]["hi"], 0)

    def test_no_test_rows_fails(self):
        x, y, mask, meta = dataset(1, 20, True)
        for m in meta:
            m["group"] = next(f"{i:016x}" for i in range(1000) if model.share(f"{i:016x}", "human-test") >= 0.2)
        actor = fresh(8)
        _, rep = model.fit_and_test(x, y, mask, meta, actor, SETTINGS)
        self.assertFalse(rep["passed"])


class InitTest(unittest.TestCase):
    def test_starts_from_the_self_play_weights(self):
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(ROOT / "training"))
        from learner import Actor, write_model
        from warm_start import read_zapw

        actor, name = model.init_state(model.BUNDLED)
        self.assertIn("v1", name)
        _, t = read_zapw(model.BUNDLED)
        s = actor.state_dict()
        self.assertEqual(float(np.abs(s["trunk.0.weight"].numpy() - t["trunk.0.weight"]).max()), 0.0)
        # A features v2 file gives its first 431 input columns (the v1 part).
        v2 = Actor(461, [8])
        f = Path(tempfile.mkdtemp()) / "v2.zapw"
        write_model(v2, f, "f32", features="v2")
        a2, _ = model.init_state(f)
        self.assertEqual(tuple(a2.state_dict()["trunk.0.weight"].shape), (8, 431))
        self.assertTrue(np.array_equal(a2.state_dict()["trunk.0.weight"].numpy(), v2.state_dict()["trunk.0.weight"].numpy()[:, :431]))


class ThresholdTest(unittest.TestCase):
    def test_off_below_either_threshold(self):
        ctx, _, _, _ = new_context()
        t = ctx.config.thresholds
        for vm, dev in ((t["human_model_matches"] - 1, t["human_model_devices"]), (t["human_model_matches"], t["human_model_devices"] - 1), (0, 0)):
            lay, path, card, _ = model.run_human_model(ctx, set(), {"validMatches": vm, "devices": dev})
            self.assertFalse(lay["on"])
            self.assertIsNone(path)
            self.assertIsNone(card)
            self.assertEqual(lay["progress"]["matches"], vm)
            self.assertEqual(lay["progress"]["people"], dev if dev >= 20 else None, "a people count under 20 is null")


if __name__ == "__main__":
    unittest.main()
