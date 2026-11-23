import random
import unittest

from zapcycle.ab import ab_matches, card_ab, decide, evaluate

WINDOW = {"version": "v3", "control": "v2", "from": 1_000_000, "until": 2_000_000}
CFG = {"rollback_drop": 0.02, "min_matches_per_arm": 200, "bootstrap": 500}


def records(n: int, p_control: float, p_candidate: float, people: int = 60, test: bool = False, group=True, seed: int = 7) -> list[dict]:
    """n matches in alternating arms; each AI team win drawn at the arm's rate, people drawn at random."""
    rng = random.Random(seed)
    out = []
    for i in range(n):
        arm = "control" if i % 2 else "candidate"
        p = p_control if arm == "control" else p_candidate
        ai_wins = rng.random() < p
        g = f"{rng.randrange(people):016x}" if group else None
        out.append({"key": f"k{i}", "kind": "solo1", "test": test, "arm": arm, "endedAt": 1_000_000 + i, "winner": 1 if ai_wins else 0, "humans": [{"seat": 0, "group": g, "weight": 1 if g else None, "flagged": False, "openDataOptOut": False, "abandoned": False}]})
    return out


class AbTest(unittest.TestCase):
    def test_clear_drop_rolls_back(self):
        m = ab_matches(records(800, 0.6, 0.45), WINDOW, "r2")
        r = evaluate(m, "v3", CFG["bootstrap"])
        self.assertEqual(r["matches"], {"candidate": 400, "control": 400})
        self.assertAlmostEqual(r["drop"], 0.15, delta=0.06)
        self.assertGreater(r["lo"], 0.02)
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "rollback")
        ab = card_ab(r, WINDOW, True)
        self.assertTrue(ab["rolledBack"])
        self.assertEqual(ab["people"], 60)

    def test_no_drop_continues_then_closes(self):
        r = evaluate(ab_matches(records(800, 0.5, 0.5), WINDOW, "r2"), "v3", CFG["bootstrap"])
        self.assertAlmostEqual(r["drop"], 0.0, delta=0.06)
        self.assertLess(r["lo"], 0.02)
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "continue")
        self.assertEqual(decide(r, CFG, WINDOW["until"], WINDOW["until"]), "close")

    def test_too_few_matches_never_roll_back(self):
        r = evaluate(ab_matches(records(300, 0.8, 0.2), WINDOW, "r2"), "v3", CFG["bootstrap"])
        self.assertGreater(r["lo"], 0.02)
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "continue")

    def test_filters(self):
        recs = records(40, 0.5, 0.5)
        recs[0]["arm"] = None
        recs[1]["kind"] = "friends"
        recs[2]["humans"][0]["abandoned"] = True
        recs[3]["endedAt"] = WINDOW["until"]
        recs[4]["test"] = True
        self.assertEqual(len(ab_matches(recs, WINDOW, "r2")), 35)
        # Seats that may not count in public numbers stay out: deleted data (no group), flagged,
        # weight 0, out of open data.
        recs[5]["humans"][0].update(group=None, weight=None)
        recs[6]["humans"][0]["flagged"] = True
        recs[7]["humans"][0]["weight"] = 0
        recs[8]["humans"][0]["openDataOptOut"] = True
        self.assertEqual(len(ab_matches(recs, WINDOW, "r2")), 31)
        self.assertEqual(len(ab_matches(records(10, 0.5, 0.5, test=True), WINDOW, "minio")), 10)
        self.assertEqual(len(ab_matches(records(10, 0.5, 0.5, test=True), WINDOW, "r2")), 0)

    def test_people_and_clusters(self):
        few = evaluate(ab_matches(records(400, 0.6, 0.4, people=10), WINDOW, "r2"), "v3", 300)
        self.assertIsNone(few["people"])
        self.assertFalse(few["bothArmsPeople"])
        # The card shows none of the comparison's numbers while an arm has fewer than 20 people,
        # also when 20 or more people played in all (30 people, one arm with 15 of them).
        self.assertEqual({k: card_ab(few, WINDOW, False)[k] for k in ("people", "drop", "lo", "hi", "detectablePoints")}, dict.fromkeys(("people", "drop", "lo", "hi", "detectablePoints")))
        lopsided = records(400, 0.6, 0.4, people=30)
        for m in lopsided:
            g = int(m["humans"][0]["group"], 16)
            if m["arm"] == "control" and g >= 15:
                m["humans"][0]["group"] = f"{g % 15:016x}"
        r = evaluate(ab_matches(lopsided, WINDOW, "r2"), "v3", 300)
        self.assertEqual((r["people"], r["bothArmsPeople"]), (30, False))
        self.assertIsNotNone(r["drop"])
        card = card_ab(r, WINDOW, False)
        self.assertEqual(card["people"], 30)
        self.assertEqual([card[k] for k in ("drop", "lo", "hi", "detectablePoints")], [None] * 4)
        both = evaluate(ab_matches(records(800, 0.6, 0.4, people=60), WINDOW, "r2"), "v3", 300)
        self.assertTrue(both["bothArmsPeople"])
        self.assertIsNotNone(card_ab(both, WINDOW, False)["drop"])
        grouped = ab_matches(records(400, 0.6, 0.4, people=10), WINDOW, "r2")
        self.assertEqual(len({m["cluster"] for m in grouped}), 10)
        # A seat without a group in the export (the person deleted their data) is left out.
        self.assertEqual(ab_matches(records(400, 0.6, 0.4, group=False), WINDOW, "r2"), [])
        # People whose matches go the same way (each person always wins or always loses) widen the
        # interval against matches drawn one by one at the same overall rate.
        rng = random.Random(3)
        clumped = [dict(m, score=int(m["cluster"], 16) % 2) for m in grouped]
        spread = [dict(m, score=int(rng.random() < 0.5)) for m in grouped]
        a, b = evaluate(clumped, "v3", 300), evaluate(spread, "v3", 300)
        self.assertGreater(a["hi"] - a["lo"], b["hi"] - b["lo"])

    def test_seeded_by_version(self):
        m = ab_matches(records(400, 0.55, 0.5), WINDOW, "r2")
        a, b, c = evaluate(m, "v3", 300), evaluate(m, "v3", 300), evaluate(m, "v4", 300)
        self.assertEqual((a["lo"], a["hi"]), (b["lo"], b["hi"]))
        self.assertNotEqual((a["lo"], a["hi"]), (c["lo"], c["hi"]))
        self.assertEqual(a["detectablePoints"], round(100 * (0.02 + (2.326 + 0.8416) * a["sd"]), 1))
        self.assertLess(a["loSeq"], a["lo"])

    def test_the_rollback_reads_the_sequential_boundary(self):
        # Checked every day, the rule rolls back only when the 1st percentile of the bootstrap drops
        # is above the limit, not the 5th percentile shown as lo.
        r = {"matches": {"candidate": 300, "control": 300}, "lo": 0.03, "hi": 0.12, "loSeq": 0.015}
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "continue")
        self.assertEqual(decide(dict(r, loSeq=0.021), CFG, 1_500_000, WINDOW["until"]), "rollback")

    def test_one_empty_arm(self):
        m = [x for x in ab_matches(records(100, 0.5, 0.5), WINDOW, "r2") if x["arm"] == "control"]
        r = evaluate(m, "v3", 300)
        self.assertIsNone(r["drop"])
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "continue")
