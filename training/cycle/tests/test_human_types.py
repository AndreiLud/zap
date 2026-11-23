"""Player types: k by BIC with a stability check, one type when nothing stands apart, the threshold
and the rule of 20 people per type."""

import math
import unittest

import numpy as np

from zapcycle import formats
from zapcycle.human import player_types as pt

from .human_support import group, new_context

S = {**pt.DEFAULTS, "refits": 20}


def readings(centers: list[list[float]], per: int, spread: float = 0.15, seed: int = 5) -> list[dict]:
    rng = np.random.default_rng(seed)
    out = []
    for c, center in enumerate(centers):
        for i in range(per):
            z = np.array([math.log(p / (1 - p)) for p in center]) + rng.normal(0, spread, 8)
            v = [round(1 / (1 + math.exp(-a)), 3) for a in z]
            out.append({"group": group(c * 1000 + i), "matches": 30, "decisions": 600, "shown": True, "values": v})
    return out


CAUTIOUS = [0.1, 0.6, 0.35, 0.05, 0.4, 0.2, 0.05, 0.9]
BOLD = [0.5, 0.15, 0.6, 0.25, 0.4, 0.05, 0.4, 0.6]
COVERER = [0.25, 0.35, 0.5, 0.15, 0.2, 0.7, 0.15, 0.8]


class AriTest(unittest.TestCase):
    def test_values(self):
        a = np.array([0, 0, 1, 1, 2, 2])
        self.assertEqual(pt.ari(a, a), 1.0)
        self.assertEqual(pt.ari(a, np.array([5, 5, 3, 3, 9, 9])), 1.0)
        self.assertEqual(pt.ari(np.zeros(5), np.zeros(5)), 1.0)
        rng = np.random.default_rng(1)
        self.assertLess(abs(pt.ari(rng.integers(0, 3, 3000), rng.integers(0, 3, 3000))), 0.02)


class ChooseTest(unittest.TestCase):
    def test_three_styles_give_three_stable_types(self):
        X = pt.matrix(readings([CAUTIOUS, BOLD, COVERER], 80))
        res = pt.choose(X, S)
        self.assertEqual(res["k"], 3)
        self.assertTrue(res["stable"])
        self.assertGreater(res["ari"], 0.7)
        block = pt.summary_block(X, res)
        self.assertEqual(block["k"], 3)
        self.assertAlmostEqual(sum(t["share"] for t in block["types"]), 1.0, places=2)
        centers = sorted(t["center"]["cover"] for t in block["types"])
        for got, want in zip(centers, [0.05, 0.2, 0.7]):
            self.assertAlmostEqual(got, want, delta=0.03)

    def test_one_blob_means_no_distinct_types(self):
        X = pt.matrix(readings([CAUTIOUS], 240, spread=0.4))
        res = pt.choose(X, S)
        self.assertEqual(res["k"], 1)
        block = pt.summary_block(X, res)
        self.assertEqual(block["k"], 1)
        self.assertEqual(block["types"][0]["share"], 1.0)

    def test_one_style_with_counting_noise_is_one_type(self):
        # The verification's case: everyone has the same style and the same tables, so the only
        # variation is counting noise. run, accept and reraise come from one multinomial draw of
        # each person's answers, so run and accept move together; with accept in the clustering a
        # diagonal mixture cut such a population into 2 or 3 types.
        rng = np.random.default_rng(21)
        style = [0.4, 0.4, 0.55, 0.05, 0.5, 0.15, 0.2, 0.9]
        rs = []
        for i in range(400):
            answers = int(rng.integers(20, 120))
            u, a, x = rng.multinomial(answers, [style[1], style[2], style[3]])
            z = np.array([math.log(p / (1 - p)) for p in style]) + rng.normal(0, 0.12, 8)
            v = [round(1 / (1 + math.exp(-t)), 3) for t in z]
            v[1], v[2], v[3] = (round((c + 1) / (answers + 3), 3) for c in (u, a, x))
            rs.append({"group": group(i), "matches": 30, "decisions": 600, "shown": True, "values": v, "population": style})
        X = pt.matrix(rs)
        self.assertEqual(X.shape, (400, 7), "accept is left out")
        self.assertLess(np.corrcoef([r["values"][1] for r in rs], [r["values"][2] for r in rs])[0, 1], -0.8)
        res = pt.choose(X, S)
        self.assertEqual((res["k"], res["chosen"]), (1, 1))
        block = pt.summary_block(X, res, pt.reference(rs))
        c = block["types"][0]["center"]
        self.assertEqual(list(c), list(pt.READING_KEYS), "the published center keeps all 8 numbers")
        self.assertAlmostEqual(c["accept"], 1 - c["run"] - c["reraise"], places=2)

    def test_one_style_at_two_mixes_of_tables_is_one_type(self):
        # The review's case: one style, half the people mostly 1 against 1 and half mostly 2 against
        # 2; each reading near the population value at that person's own mix of segments.
        rng = np.random.default_rng(8)
        one = [0.633, 0.35, 0.55, 0.1, 0.55, 0.2, 0.06, 0.92]
        two = [0.357, 0.52, 0.42, 0.06, 0.6, 0.15, 0.06, 0.92]
        rs = []
        for i in range(400):
            pop = one if i % 2 else two
            z = np.array([math.log(p / (1 - p)) for p in pop]) + rng.normal(0, 0.12, 8)
            rs.append({"group": group(i), "matches": 30, "decisions": 600, "shown": True, "values": [round(1 / (1 + math.exp(-a)), 3) for a in z], "population": pop})
        res = pt.choose(pt.matrix(rs), {**S, "max_k": 2})
        self.assertEqual(res["k"], 1, "the mix of tables is not a type")
        raw = pt.choose(pt.matrix([{k: v for k, v in r.items() if k != "population"} for r in rs]), {**S, "max_k": 2})
        self.assertEqual(raw["k"], 2, "read on raw values, the mix of tables looks like two types")
        block = pt.summary_block(pt.matrix(rs), res, pt.reference(rs))
        mid = 1 / (1 + math.exp(-(math.log(0.633 / 0.367) + math.log(0.357 / 0.643)) / 2))
        self.assertAlmostEqual(block["types"][0]["center"]["raise"], mid, delta=0.02)

    def test_a_type_under_20_people_is_not_published(self):
        X = pt.matrix(readings([CAUTIOUS, BOLD], 100) + readings([COVERER], 12, seed=9))
        res = pt.choose(X, S)
        if res["k"] == 3:
            self.assertIsNone(pt.summary_block(X, res))


class LayerTest(unittest.TestCase):
    def test_threshold(self):
        ctx, _, _, _ = new_context()
        ctx.config = ctx.config.with_values("thresholds", player_types_devices=200).with_values("human", player_types={**S})
        few = readings([CAUTIOUS, BOLD], 99)
        lay, block, _ = pt.run_player_types(ctx, few)
        self.assertFalse(lay["on"])
        self.assertIsNone(block)
        self.assertEqual(lay["progress"]["people"], 198)
        # People with a number not shown do not count.
        hidden = [{**r, "shown": False} for r in readings([COVERER], 50, seed=2)]
        lay, block, _ = pt.run_player_types(ctx, few + hidden)
        self.assertFalse(lay["on"])
        many = readings([CAUTIOUS, BOLD, COVERER], 80)
        lay, block, rep = pt.run_player_types(ctx, many)
        self.assertTrue(lay["on"])
        self.assertEqual(block["k"], 3)
        summary = {
            "schema": "zap-summary/1", "generatedAt": 1, "minPeople": 20, "training": {"state": "ok", "finishedAt": None, "current": "v1", "nextAfter": None},
            "humansVsZap": {"matches": 0, "humanWins": 0, "since": None}, "versions": [], "ab": None,
            "layers": {k: {"on": False, "why": "x", "progress": {}} for k in formats.LAYER_KEYS} | {"playerTypes": lay}, "cells": [], "playerTypes": block,
        }
        self.assertEqual(formats.validate("zap-summary/1", summary), [])


if __name__ == "__main__":
    unittest.main()
