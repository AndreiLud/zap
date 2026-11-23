import copy
import json
import unittest
from pathlib import Path

from zapcycle import formats
from zapcycle.config import ROOT
from zapcycle.errors import FormatError

from .samples import BUNDLED, gate_result, manifest_v1, status

FIXTURES = ROOT / "tests" / "fixtures" / "cycle"


class FixtureTest(unittest.TestCase):
    """Every valid fixture of tests/fixtures/cycle is accepted, every invalid one refused (W1's set)."""

    def test_fixtures(self):
        dirs = [d for d in sorted(FIXTURES.iterdir()) if d.is_dir() and f"{d.name}/1" in formats.VALIDATORS] if FIXTURES.is_dir() else []
        if not dirs:
            self.skipTest("tests/fixtures/cycle is not there yet")
        for d in dirs:
            schema = f"{d.name}/1"
            for f in sorted((d / "valid").glob("*.json")):
                with self.subTest(file=str(f.relative_to(FIXTURES))):
                    self.assertEqual(formats.validate(schema, json.loads(f.read_text())), [])
            for f in sorted((d / "invalid").glob("*.json")):
                with self.subTest(file=str(f.relative_to(FIXTURES))):
                    try:
                        formats.load(schema, f.read_bytes())
                    except FormatError:
                        continue
                    self.fail(f"{f.name} was accepted")


class FormatTest(unittest.TestCase):
    def test_samples_are_valid(self):
        formats.check("zap-manifest/1", manifest_v1())
        formats.check("zap-status/1", status())
        formats.check("zap-gate/1", gate_result("v2", "a" * 64, "v1", "b" * 64, True))

    def test_manifest_rules(self):
        m = manifest_v1()
        bad = {**m, "extra": 1}
        self.assertTrue(any("unexpected field extra" in e for e in formats.validate("zap-manifest/1", bad)))
        self.assertTrue(formats.validate("zap-manifest/1", {**m, "control": "v1", "controlUntil": 5}))
        self.assertTrue(formats.validate("zap-manifest/1", {**m, "controlUntil": 5}))
        self.assertTrue(formats.validate("zap-manifest/1", {**m, "controlShare": 0.6}))
        self.assertTrue(formats.validate("zap-manifest/1", {**m, "current": "v2"}))
        v2 = copy.deepcopy(m)
        v2["models"]["v2"] = {**v2["models"]["v1"], "features": "v2"}
        self.assertTrue(any("adapt" in e for e in formats.validate("zap-manifest/1", v2)))
        v2["models"]["v2"]["adapt"] = {"bmax": 0.1, "nHalf": 2}
        self.assertEqual(formats.validate("zap-manifest/1", v2), [])
        v2["models"]["v2"]["personas"] = {"zap": {**BUNDLED["personas"]["zap"], "temperature": float("inf")}}
        self.assertTrue(formats.validate("zap-manifest/1", v2))

    def test_status_and_export_rules(self):
        self.assertTrue(formats.validate("zap-status/1", {**status(), "step": "walk"}))
        self.assertTrue(formats.validate("zap-status/1", {**status(), "message": "x" * 501}))
        self.assertTrue(formats.validate("zap-status/1", {**status(), "state": "running"}))
        row = {"matchId": "0b6f3a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "seat": 1, "weight": 0.5, "flagged": False, "openDataOptOut": False, "noAdapt": False, "group": "0123456789abcdef"}
        ex = {"schema": "zap-export/1", "date": "2026-11-21", "createdAt": 1, "partial": False, "rows": [row], "reports": []}
        self.assertEqual(formats.validate("zap-export/1", ex), [])
        self.assertTrue(formats.validate("zap-export/1", {**ex, "rows": [{**row, "weight": 0.1234}]}))
        self.assertTrue(formats.validate("zap-export/1", {**ex, "rows": [{**row, "pseudonym": "x"}]}))
        self.assertTrue(formats.validate("zap-export/1", {**ex, "date": "2026-02-30"}))

    def test_key_lists_match_the_typescript_sources(self):
        import subprocess

        code = "Promise.all([import('./ai/src/net-agent.ts'), import('./ai/src/heuristic.ts')]).then(([n, h]) => console.log(JSON.stringify([Object.keys(n.NEUTRAL_KNOBS), Object.keys(h.BASE_PARAMS)])))"
        out = subprocess.run(["node", "-e", code], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        knobs, style = json.loads(out)
        self.assertEqual(tuple(knobs), formats.KNOB_KEYS)
        self.assertEqual(tuple(style), formats.STYLE_KEYS)

    def test_size_is_checked_before_parsing(self):
        with self.assertRaisesRegex(FormatError, "over the limit"):
            formats.load("zap-status/1", b" " * (16 * 1024 + 1))

    def test_flags_and_summary_rules(self):
        op = {"ref": "2026-11-21:0123456789abcdef", "op": "flag", "reason": "volume", "evidence": "412 matches in 7 days", "at": 5}
        f = {"schema": "zap-flags/1", "createdAt": 6, "ops": [op, {"ref": op["ref"], "op": "clear", "at": 6}]}
        self.assertEqual(formats.validate("zap-flags/1", f), [])
        self.assertTrue(formats.validate("zap-flags/1", {**f, "ops": [{**op, "evidence": "olá"}]}))
        self.assertTrue(formats.validate("zap-flags/1", {**f, "ops": [{**op, "ref": "2026-11-21:XYZ"}]}))
        self.assertTrue(formats.validate("zap-flags/1", {**f, "ops": [{**op, "at": 7}]}))
        from zapcycle.human import layers_off

        s = {"schema": "zap-summary/1", "generatedAt": 1, "minPeople": 20, "training": {"state": "ok", "finishedAt": None, "current": "v1", "nextAfter": None}, "humansVsZap": {"matches": 3, "humanWins": 1, "since": 1}, "versions": [], "ab": None, "layers": layers_off(5), "cells": [{"week": "2026-W47", "variant": "paulista", "players": 2, "people": 20, "matches": 30, "humanWinRate": 0.4}], "playerTypes": None}
        self.assertEqual(formats.validate("zap-summary/1", s), [])
        self.assertTrue(formats.validate("zap-summary/1", {**s, "cells": [{**s["cells"][0], "people": 19}]}))
        self.assertTrue(formats.validate("zap-summary/1", {**s, "minPeople": 10}))

    def test_summary_v2_rules(self):
        """zap-summary/2 (milestone 7): both schema names reach the same check, the new blocks keep
        the floor of 20 people, and a /1 file may not carry a /2 field."""
        valid = [json.loads(f.read_text()) for f in sorted((FIXTURES / "zap-summary" / "valid").glob("*.json"))]
        self.assertGreaterEqual(sum(1 for s in valid if s["schema"] == "zap-summary/2"), 2)
        self.assertGreaterEqual(sum(1 for s in valid if s["schema"] == "zap-summary/1"), 2)
        self.assertIs(formats.VALIDATORS["zap-summary/2"], formats.VALIDATORS["zap-summary/1"])
        full = next(s for s in valid if s["schema"] == "zap-summary/2" and s["scoreboard"])
        self.assertEqual(formats.validate("zap-summary/2", full), [])
        for broken in (
            lambda x: x["scoreboard"][1].__setitem__("people", 19),
            lambda x: x["versions"][2]["data"].__setitem__("people", 19),
            lambda x: x["disagreements"]["types"][0].__setitem__("people", 19),
            lambda x: x["scoreboard"][0].__setitem__("partnerVersion", "v3"),
            lambda x: x["scoreboard"][1].__setitem__("partnerVersion", None),
            lambda x: x["versions"][1]["personas"]["stats"]["zap"].__setitem__("vsZap", 1.5),
            lambda x: x.pop("disagreements"),
        ):
            x = copy.deepcopy(full)
            broken(x)
            self.assertTrue(formats.validate("zap-summary/2", x))
        v1 = next(s for s in valid if s["schema"] == "zap-summary/1")
        self.assertTrue(formats.validate("zap-summary/1", {**v1, "scoreboard": []}))
        self.assertTrue(formats.validate("zap-summary/1", {**v1, "schema": "zap-summary/3"}))
        self.assertEqual(formats.SIZE_LIMITS["zap-summary/2"], formats.SIZE_LIMITS["zap-summary/1"])
