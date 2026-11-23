"""summary.json in zap-summary/2 (milestone 7, _local/m7/DATA-SPEC.md 2.2.3): what each served
version carries from its card (twin, characters with their pairs, data), the seed noise of the
newest card, the scoreboard by mode and versions with its floor of 20 people, and a publish that
writes the new schema."""

import json
import unittest
from datetime import datetime, timezone

from zapcycle import formats
from zapcycle.publish import init, publish
from zapcycle.summary import PERSONA_PAIRS_FILE, build_summary, inputs_path, save_inputs, scoreboard, seed_noise

from .helpers import fake_cycle, temp_config
from .samples import make_candidate, status

T0 = int(datetime(2026, 11, 22, 12, tzinfo=timezone.utc).timestamp() * 1000)
DAY = 86_400_000


def line(i: int, group: str | None, kind: str = "solo1", segment: str = "paulista-2", ai: str = "v2", partner: str = "v2", seat: int = 0, winner: int = 0, **h) -> dict:
    human = {"seat": seat, "group": group, "weight": 1 if group else None, "flagged": False, "openDataOptOut": False, "noAdapt": False, "verified": True, "abandoned": False}
    human.update(h)
    return {"key": f"k{i}", "matchId": f"m{i}", "kind": kind, "segment": segment, "startedAt": T0, "endedAt": T0 + i, "test": False, "arm": None, "aiVersion": ai, "partnerVersion": partner, "winner": winner, "humans": [human]}


class ScoreboardTest(unittest.TestCase):
    def test_rows_by_mode_and_versions_with_20_people_or_more(self):
        recs = []
        # 1 against 1, v2: 20 people, one match each, the person wins every third match.
        recs += [line(i, f"{i:016x}", winner=0 if i % 3 == 0 else 1) for i in range(20)]
        # 2 against 2 facing v2 with a v1 partner: 25 people, two matches each; the person sits on seat 1.
        recs += [line(100 + i, f"{1000 + i % 25:016x}", kind="solo2", segment="paulista-4", ai="v2", partner="v1", seat=1, winner=1) for i in range(50)]
        # 2 against 2 facing v2 with a v2 partner: only 19 people, no row.
        recs += [line(200 + i, f"{2000 + i:016x}", kind="solo2", segment="paulista-4", ai="v2", partner="v2") for i in range(19)]
        # Seats that may not count in public numbers, and kinds that are not quick play.
        recs += [line(300 + i, None, segment="mineiro-2") for i in range(30)]
        recs += [line(400 + i, f"{4000 + i:016x}", segment="mineiro-2", openDataOptOut=True) for i in range(30)]
        recs += [line(500 + i, f"{5000 + i:016x}", segment="mineiro-2", flagged=True, weight=0) for i in range(30)]
        recs += [line(600 + i, f"{6000 + i:016x}", kind="friends", segment="mineiro-2") for i in range(30)]
        rows = scoreboard(recs)
        self.assertEqual(
            rows,
            [
                {"variant": "paulista", "players": 2, "aiVersion": "v2", "partnerVersion": None, "people": 20, "matches": 20, "humanWins": 7},
                {"variant": "paulista", "players": 4, "aiVersion": "v2", "partnerVersion": "v1", "people": 25, "matches": 50, "humanWins": 50},
            ],
        )
        # The rows pass the public format's checks (and so the Worker's).
        base = json.loads((formats_fixture("v2-start")).read_text())
        self.assertEqual(formats.validate("zap-summary/2", {**base, "scoreboard": rows}), [])

    def test_one_more_person_opens_the_row(self):
        recs = [line(200 + i, f"{2000 + i:016x}", kind="solo2", segment="mineiro-4", partner="v1") for i in range(19)]
        self.assertEqual(scoreboard(recs), [])
        recs.append(line(299, "f" * 16, kind="solo2", segment="mineiro-4", partner="v1"))
        self.assertEqual([(r["variant"], r["players"], r["people"]) for r in scoreboard(recs)], [("mineiro", 4, 20)])


def formats_fixture(name: str):
    from zapcycle.config import ROOT

    return ROOT / "tests" / "fixtures" / "cycle" / "zap-summary" / "valid" / f"{name}.json"


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


class BuildSummaryV2Test(unittest.TestCase):
    def setUp(self):
        self.cfg, self.tmp = temp_config("test")
        self.clock = Clock()
        self.cyc, self.s3 = fake_cycle(self.cfg, clock=self.clock)
        self.P = self.cfg.storage["public_bucket"]
        init(self.cyc)

    def candidate(self, cycle_id: str, passed: bool = True, pairs_per_segment: int | None = 400, order_pairs: int | None = None, noise: dict | None = None, data: dict | None = None):
        v = self.cyc.next_version(self.cyc.require_manifest())
        work = make_candidate(self.cyc, cycle_id, v, self.cyc.require_manifest()["current"], passed)
        cal = json.loads((work / "gate" / "personas.json").read_text())
        if pairs_per_segment is not None:
            cal["pairsPerSegment"] = pairs_per_segment
        (work / "gate" / "personas.json").write_text(json.dumps(cal))
        if order_pairs is not None:
            order = {"pairsPerSegment": order_pairs, "order": cal["order"], "stats": {"zap": {**cal["stats"]["zap"], "vsZap": 0.49}}}
            (work / "gate" / "personas-order.json").write_text(json.dumps(order))
        twin = {"sha256": "1" * 64, "headToHead": {"pairs": 2000, "mean": 0.512, "lo": 0.497, "hi": 0.527}, "seedFloor": None, "seedFloorCycle": None, "seedNoise": noise}
        (work / "gate" / "twin.json").write_text(json.dumps(twin))
        if data is not None:
            (work / "tables").mkdir(parents=True, exist_ok=True)
            (work / "tables" / "data.json").write_text(json.dumps(data))
        return v, work

    def data(self, people):
        return {
            "records": 120, "valid": 118, "invalid": 2, "test": 0, "validMatches": 110, "linkedSeats": 130, "people": people,
            "recordsSha256": "d" * 64, "exportDate": None, "exportSha256": None,
            "excluded": {"unlinked": 0, "flagged": 0, "friends": 0, "auto": 0, "forced": 0, "capped": 0},
        }

    def test_a_publish_writes_zap_summary_2_with_the_card_fields(self):
        v, work = self.candidate("20261121-2200", pairs_per_segment=400, noise={"floors": 1, "rms": 0.0123}, data=self.data(31))
        self.assertEqual(publish(self.cyc, "20261121-2200")["result"], "promoted")
        s = self.s3.json(self.P, "summary.json")
        self.assertEqual(s["schema"], "zap-summary/2")
        formats.check("zap-summary/2", s)
        by = {x["version"]: x for x in s["versions"]}
        self.assertEqual((by["v1"]["twin"], by["v1"]["personas"], by["v1"]["data"]), (None, None, None))
        self.assertEqual(by[v]["twin"], {"pairs": 2000, "mean": 0.512, "lo": 0.497, "hi": 0.527})
        # 400 pairs per segment, the four segments pooled.
        self.assertEqual(by[v]["personas"]["pairs"], 1600)
        self.assertEqual(by[v]["personas"]["stats"]["zap"]["vsZap"], 0.5)
        self.assertEqual(by[v]["data"], {"validMatches": 110, "people": 31})
        self.assertEqual(s["seedNoise"], {"floors": 1, "rms": 0.0123})
        self.assertEqual((s["scoreboard"], s["disagreements"]), ([], None))
        # The pairs stay with the version once the cycle's work folder is pruned.
        kept = json.loads((self.cyc.version_dir(v) / PERSONA_PAIRS_FILE).read_text())
        self.assertEqual((kept["pairs"], kept["pairsPerSegment"]), (1600, 400))
        import shutil

        shutil.rmtree(work)
        again = build_summary(self.cyc, self.cyc.require_manifest(), status())
        self.assertEqual({x["version"]: x["personas"] for x in again["versions"]}[v]["pairs"], 1600)

    def test_the_order_file_gives_the_pairs_when_the_card_took_its_numbers(self):
        v, _ = self.candidate("20261121-2200", pairs_per_segment=400, order_pairs=800)
        publish(self.cyc, "20261121-2200")
        s = self.s3.json(self.P, "summary.json")
        by = {x["version"]: x for x in s["versions"]}
        self.assertEqual(by[v]["personas"]["pairs"], 3200)
        self.assertEqual(by[v]["personas"]["stats"]["zap"]["vsZap"], 0.49)

    def test_without_a_pair_count_the_characters_stay_out_and_few_people_stay_hidden(self):
        v, _ = self.candidate("20261121-2200", pairs_per_segment=None, data=self.data(None))
        publish(self.cyc, "20261121-2200")
        s = self.s3.json(self.P, "summary.json")
        formats.check("zap-summary/2", s)
        by = {x["version"]: x for x in s["versions"]}
        self.assertIsNone(by[v]["personas"])
        self.assertEqual(by[v]["data"], {"validMatches": 110, "people": None})
        self.assertIsNone(s["seedNoise"])

    def test_seed_noise_comes_from_the_newest_card_that_has_it_rejected_ones_too(self):
        self.candidate("20261121-2200", noise={"floors": 1, "rms": 0.01})
        publish(self.cyc, "20261121-2200")
        # The window of the promotion closes; a later candidate is rejected but measured a floor.
        self.clock.t += 15 * DAY
        m = self.cyc.require_manifest()
        m.update({"control": None, "controlUntil": None})
        self.cyc.put_json(self.cyc.models, "manifest.json", "zap-manifest/1", m)
        self.cyc.state["ab"] = None
        self.cyc.state.save()
        self.candidate("20261206-2200", passed=False, noise={"floors": 2, "rms": 0.02})
        self.assertEqual(publish(self.cyc, "20261206-2200")["result"], "rejected")
        self.assertEqual(seed_noise(self.cyc, self.cyc.require_manifest()), {"floors": 2, "rms": 0.02})

    def test_inputs_from_before_milestone_7_still_build_a_valid_summary(self):
        # summary-inputs.json written by the /1 builder has no scoreboard.
        inputs_path(self.cyc).parent.mkdir(parents=True, exist_ok=True)
        inputs_path(self.cyc).write_text(json.dumps({"humansVsZap": {"matches": 3, "humanWins": 1, "since": T0}, "cells": [], "layers": None, "playerTypes": None, "ab": None}))
        s = build_summary(self.cyc, self.cyc.require_manifest(), status())
        self.assertEqual(formats.validate("zap-summary/2", s), [])
        self.assertEqual(s["scoreboard"], [])

    def test_save_inputs_keeps_the_scoreboard_and_a_later_save_without_records_keeps_it_too(self):
        # The test profile runs in minio mode, where only records of a local test site count.
        recs = [{**line(i, f"{i:016x}"), "test": True} for i in range(21)]
        p = self.tmp / "records.jsonl"
        p.write_text("".join(json.dumps(r) + "\n" for r in recs))
        save_inputs(self.cyc, p, None, None)
        self.assertEqual(len(json.loads(inputs_path(self.cyc).read_text())["scoreboard"]), 1)
        save_inputs(self.cyc, None, None, None)
        s = build_summary(self.cyc, self.cyc.require_manifest(), status())
        self.assertEqual([(r["aiVersion"], r["people"]) for r in s["scoreboard"]], [("v2", 21)])
        self.assertEqual(formats.validate("zap-summary/2", s), [])


if __name__ == "__main__":
    unittest.main()
