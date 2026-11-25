import random
import unittest

from zapcycle.ab import ab_matches, card_ab, decide, evaluate, undecided
from zapcycle.formats import MIN_PEOPLE

WINDOW = {"version": "v3", "control": "v2", "from": 1_000_000, "until": 2_000_000}
CFG = {"rollback_drop": 0.02, "min_matches_per_arm": 200, "min_people_per_arm": 20, "bootstrap": 500}


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
        r = {"matches": {"candidate": 300, "control": 300}, "armPeople": {"candidate": 40, "control": 40}, "lo": 0.03, "hi": 0.12, "loSeq": 0.015}
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "continue")
        self.assertEqual(decide(dict(r, loSeq=0.021), CFG, 1_500_000, WINDOW["until"]), "rollback")

    def test_one_empty_arm(self):
        m = [x for x in ab_matches(records(100, 0.5, 0.5), WINDOW, "r2") if x["arm"] == "control"]
        r = evaluate(m, "v3", 300)
        self.assertIsNone(r["drop"])
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "continue")


def arm(name: str, people: int, n: int, p: float, seed: int, first: int = 0, group=True) -> list[dict]:
    """n matches of one arm, as ab_matches gives them, spread round robin over `people` groups
    (people 0 and group False: no group at all); score 1 (the AI team won) drawn at rate p."""
    rng = random.Random(seed)
    out = []
    for i in range(n):
        g = f"{first + i % people:016x}" if group and people else None
        out.append({"arm": name, "score": int(rng.random() < p), "cluster": g or f"seat:{name}{i}:0", "group": g})
    return out


class RollbackNeedsPeopleTest(unittest.TestCase):
    """The rollback needs min_people_per_arm distinct people in each arm as well as matches: with
    one or a few people the bootstrap over people has almost no spread, and a check on their matches
    alone rolls an equal version back on noise."""

    def test_one_person_with_many_matches_and_a_big_drop_never_rolls_back(self):
        m = ab_matches(records(800, 0.7, 0.3, people=1), WINDOW, "r2")
        r = evaluate(m, "v3", 300)
        self.assertEqual(r["matches"], {"candidate": 400, "control": 400})
        self.assertEqual(r["armPeople"], {"candidate": 1, "control": 1})
        # One cluster: every resample is the same, so the boundary equals the drop. The rule of
        # matches alone would roll back here.
        self.assertAlmostEqual(r["sd"], 0, places=9)
        self.assertGreater(r["loSeq"], CFG["rollback_drop"])
        self.assertEqual(decide(r, dict(CFG, min_people_per_arm=1), 1_500_000, WINDOW["until"]), "rollback")
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "continue")
        self.assertEqual(decide(r, CFG, WINDOW["until"], WINDOW["until"]), "close")

    def test_twenty_people_in_each_arm_with_a_real_drop_roll_back(self):
        m = arm("candidate", 25, 300, 0.3, 1) + arm("control", 25, 300, 0.7, 2, first=100)
        r = evaluate(m, "v3", 300)
        self.assertEqual(r["armPeople"], {"candidate": 25, "control": 25})
        self.assertTrue(r["bothArmsPeople"])
        self.assertGreater(r["loSeq"], CFG["rollback_drop"])
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "rollback")
        self.assertIsNone(undecided(r, CFG, WINDOW))

    def test_the_boundary_is_twenty_people_in_each_arm(self):
        self.assertEqual(CFG["min_people_per_arm"], MIN_PEOPLE)
        for candidate, control, want in ((19, 40, "continue"), (40, 19, "continue"), (20, 20, "rollback"), (20, 40, "rollback")):
            m = arm("candidate", candidate, 300, 0.3, 3) + arm("control", control, 300, 0.7, 4, first=100)
            r = evaluate(m, "v3", 300)
            self.assertEqual(r["armPeople"], {"candidate": candidate, "control": control})
            self.assertGreater(r["loSeq"], CFG["rollback_drop"], (candidate, control))
            self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), want, (candidate, control))
            # The card's floor is the same number: no comparison below it, so no rollback either.
            self.assertEqual(r["bothArmsPeople"], want == "rollback")

    def test_matches_without_a_group_are_nobody(self):
        grouped = arm("candidate", 19, 150, 0.3, 5) + arm("control", 30, 300, 0.7, 6, first=100)
        loose = arm("candidate", 0, 150, 0.3, 7, group=False)
        r = evaluate(grouped + loose, "v3", 300)
        self.assertEqual(r["matches"], {"candidate": 300, "control": 300})
        self.assertEqual(r["armPeople"], {"candidate": 19, "control": 30})
        self.assertEqual(decide(r, CFG, 1_500_000, WINDOW["until"]), "continue")
        one_more = evaluate(grouped + loose + arm("candidate", 1, 1, 0.3, 8, first=50), "v3", 300)
        self.assertEqual(one_more["armPeople"]["candidate"], 20)
        self.assertEqual(decide(one_more, CFG, 1_500_000, WINDOW["until"]), "rollback")
        # A result without the count (saved by a version before the rule) holds nobody.
        self.assertEqual(decide({k: v for k, v in one_more.items() if k != "armPeople"}, CFG, 1_500_000, WINDOW["until"]), "continue")

    def test_the_close_says_why_the_rollback_could_not_decide(self):
        r = evaluate(ab_matches(records(800, 0.7, 0.3, people=1), WINDOW, "r2"), "v3", 300)
        note = undecided(r, CFG, WINDOW)
        self.assertIn("The automatic rollback could not decide: too few people played (1 with v3, 1 with v2; it needs 20 in each group)", note)
        self.assertIn("Only a rollback by hand (rollback v2) brings v2 back.", note)
        self.assertNotIn("too few matches", note)
        few = evaluate(arm("candidate", 3, 50, 0.3, 9) + arm("control", 2, 20, 0.7, 10, first=100), "v3", 300)
        self.assertIn("too few people played (3 with v3, 2 with v2; it needs 20 in each group) and too few matches (50 with v3, 20 with v2; it needs 200 in each group)", undecided(few, CFG, WINDOW))
        enough_people = evaluate(arm("candidate", 30, 100, 0.5, 11) + arm("control", 30, 100, 0.5, 12, first=100), "v3", 300)
        self.assertIn("could not decide: too few matches (100 with v3, 100 with v2;", undecided(enough_people, CFG, WINDOW))
