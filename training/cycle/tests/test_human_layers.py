"""The human layers end to end on synthetic people (node/human/synth.ts plays the matches with the
rules engine, node/build.ts makes the tables): every layer off below its threshold and on above
it, flags on the bots and not on the people, the population priors, the human model split, the
open data package and the public summary."""

import argparse
import hashlib
import io
import json
import socket
import unittest
import urllib.request
import zipfile
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from zapcycle import formats
from zapcycle.human import FAILED_WHY, command, flags, model, opendata, run_human_layers
from zapcycle.summary import build_summary, save_inputs

from .human_support import synth_profile, new_context
from .samples import manifest_v1, status

LOW = {
    "human_model_matches": 20, "human_model_devices": 10, "priors_people": 10, "player_types_devices": 20,
    "open_data_matches": 50, "open_data_style_matches": 3, "min_cell_people": 20,
}
SYNTH = ("--people", "30", "--matches", "4", "--bots", "metronome,clock,volume,script", "--bot-matches", "30", "--segment", "paulista-2",
         "--opt-out", "0.1", "--no-adapt", "0.1", "--unlinked", "0.05", "--seed", "5eed0001", "--start", "2026-11-02T00:00:00Z")
ON = {"OPEN_DATA_ENABLED": "true"}


def configured(ctx, thresholds: dict):
    h = ctx.config.human
    cfg = ctx.config.with_values("thresholds", **thresholds).with_values(
        "human",
        model={**h["model"], "epochs": 2},
        flags={**h["flags"], "volume_matches": 30},
        player_types={**h["player_types"], "refits": 10},
    )
    ctx.config = cfg
    return ctx


class SyntheticPeopleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx, cls.cyc, cls.s3, cls.tmp = new_context()
        configured(cls.ctx, LOW)
        cls.truth = synth_profile(cls.ctx, cls.tmp, *SYNTH)
        # As sync records the export it kept: the open data package names the export it came from.
        latest = cls.ctx.data_dir / "exports" / "latest.json"
        cls.ctx.state["latestExport"] = {"date": cls.truth["export"]["date"], "sha256": hashlib.sha256(latest.read_bytes()).hexdigest(), "key": f"exports/{cls.truth['export']['date']}.json", "etag": "e"}
        cls.models = cls.ctx.config.storage["models_bucket"]
        cls.result = run_human_layers(cls.ctx, env=ON)
        cls.report = json.loads((cls.ctx.work_dir / "human" / "report.json").read_text())

    def bots(self) -> dict[str, str]:
        return {p["group"]: p["bot"] for p in self.truth["people"] if p["bot"]}

    def test_no_layer_failed(self):
        self.assertEqual(self.report["errors"], {})
        self.assertEqual(set(self.result.layers), set(formats.LAYER_KEYS))
        self.assertFalse(self.result.layers["adaptation"]["on"])
        self.assertFalse(self.result.layers["ranking"]["on"])

    def test_flags_fire_on_bots_and_stay_quiet_on_people(self):
        doc = self.s3.json(self.models, flags.FLAGS_KEY)
        self.assertEqual(formats.validate("zap-flags/1", doc), [])
        got = {o["ref"].split(":")[1]: o["reason"] for o in doc["ops"]}
        want = {"metronome": "regular-times", "clock": "around-the-clock", "volume": "volume", "script": "identical-sequences"}
        self.assertEqual(got, {g: want[b] for g, b in self.bots().items()})
        self.assertTrue(self.result.layers["flags"]["on"])

    def test_priors_from_people(self):
        pri = formats.load("zap-priors/1", self.s3.buckets[self.models]["control/priors.json"]["body"])
        self.assertEqual(pri["source"], "people")
        self.assertGreaterEqual(pri["people"], LOW["priors_people"])
        self.assertTrue(self.result.layers["priors"]["on"])
        self.assertEqual(pri["createdAt"], self.ctx.now_ms)

    def test_human_model_split_and_rows(self):
        lay = self.result.layers["humanModel"]
        rep = self.report["humanModel"]
        self.assertIn("passed", rep)
        self.assertEqual(lay["on"], rep["passed"])
        self.assertEqual(self.result.human_model_report, {"sha256": rep["sha256"], "pass": rep["passed"]})
        d = self.ctx.work_dir / "human" / "model"
        meta = [json.loads(line) for line in (d / "human-meta.jsonl").read_text().splitlines()]
        groups = {m["group"] for m in meta}
        self.assertEqual(groups & set(self.bots()), set(), "groups flagged in this cycle leave the human model at once")
        unlinked = {p["group"] for p in self.truth["people"] if p["unlinked"]}
        self.assertEqual(groups & unlinked, set())
        test = model.split([m["group"] for m in meta], 0.2)
        self.assertEqual({m["group"] for m, t in zip(meta, test) if t} & {m["group"] for m, t in zip(meta, test) if not t}, set())
        self.assertEqual(rep["rows"]["test"], int(test.sum()))
        self.assertTrue((d / model.MODEL_NAME).exists())
        if rep["passed"]:
            self.assertEqual(self.result.human_model, self.ctx.data_dir / "human" / model.MODEL_NAME)
        else:
            self.assertIsNone(self.result.human_model)

    def test_open_data_package(self):
        self.assertTrue(self.result.layers["openData"]["on"])
        z = Path(self.report["openData"]["zip"])
        with zipfile.ZipFile(z) as zf:
            files = {Path(n).name: zf.read(n).decode() for n in zf.namelist()}
        self.assertEqual(set(files), set(opendata.FILES))
        cells = [line.split(",") for line in files["cells.csv"].splitlines()[1:]]
        self.assertTrue(cells, "the synthetic week holds one cell of more than 20 people")
        self.assertTrue(all(int(c[3]) >= 20 for c in cells))
        # Every match whose people are linked, not opted out and not flagged, and nothing else.
        lines = [json.loads(line) for line in (self.ctx.tables_dir / "records.jsonl").read_text().splitlines()]
        bots = set(self.bots())
        eligible = [r for r in lines if all(h["group"] and not h["openDataOptOut"] and not h["flagged"] and h["group"] not in bots for h in r["humans"])]
        m = json.loads(files["manifest.json"])
        self.assertEqual(m["matches"], len(eligible))
        self.assertEqual(len(files["matches.csv"].splitlines()) - 1, len(eligible))
        self.assertTrue(m["test"])
        self.assertEqual(m["license"], "CC-BY-4.0")
        text = "\n".join(files.values())
        for r in lines:
            self.assertNotIn(r["matchId"], text)
        for p in self.truth["people"]:
            self.assertNotIn(p["group"], text)
        for rec in (self.ctx.data_dir / "records").rglob("*.json"):
            self.assertNotIn(json.loads(rec.read_text())["seed"], text)
        self.assertIn("CC BY 4.0", files["LICENSE.md"])
        self.assertFalse((z.parent / "selection.jsonl").exists(), "the link from codes to matches is not kept")
        style = files["style.csv"].splitlines()
        self.assertEqual(style[0].split(","), opendata.STYLE_COLUMNS)
        self.assertTrue(all(int(row.split(",")[1]) >= 20 for row in style[1:]), "aggregates over at least 20 people")
        self.assertEqual(m["stylePeople"], sum(int(row.split(",")[1]) for row in style[1:]))
        # The export the package came from, which the upload compares with the newest one.
        self.assertEqual((m["exportDate"], m["exportSha256"]), (self.ctx.state["latestExport"]["date"], self.ctx.state["latestExport"]["sha256"]))

    def test_summary_is_valid(self):
        save_inputs(self.cyc, self.ctx.tables_dir / "records.jsonl", self.result.layers, self.result.summary.get("playerTypes"))
        s = build_summary(self.cyc, manifest_v1(), status())
        self.assertEqual(formats.validate("zap-summary/1", s), [])
        self.assertEqual(s["layers"], self.result.layers)
        for name, lay in s["layers"].items():
            for k, v in lay["progress"].items():
                if k == "people":
                    self.assertTrue(v is None or v >= 20, f"{name}.{k}")

    def test_commands(self):
        out = command("flags", self.ctx, argparse.Namespace(action="list", ref=None))
        self.assertEqual(out["command"], "flags")
        self.assertEqual(len(out["pending"]), 4)
        built = self.report["openData"]["sha256"]
        buf = io.StringIO()
        boom = mock.Mock(side_effect=AssertionError("a connection was opened"))
        # The dry run prints to stderr: stdout holds the command's one JSON object.
        with redirect_stderr(buf), mock.patch.object(socket, "create_connection", boom), mock.patch.object(urllib.request, "urlopen", boom):
            out = command("open-data", self.ctx, argparse.Namespace(upload=True), env={**ON, "GITHUB_RELEASES_TOKEN": "github_pat_unit"})
        boom.assert_not_called()
        self.assertTrue(out["upload"]["dryRun"], "local profiles only ever print the requests")
        self.assertEqual([q["method"] for q in out["upload"]["requests"]], ["GET", "POST", "POST"])
        self.assertIn("dry run:", buf.getvalue())
        self.assertNotIn("github_pat_unit", buf.getvalue())
        self.assertEqual(out["package"]["sha256"], built, "the upload sends the package the cycle built, not a new one")


class ThresholdsTest(unittest.TestCase):
    """The same people with the production thresholds: every threshold layer stays off."""

    def test_layers_stay_off_below_the_thresholds(self):
        ctx, cyc, s3, tmp = new_context()
        configured(ctx, {})
        synth_profile(ctx, tmp, "--people", "12", "--matches", "2", "--seed", "5eed0002", "--segment", "mineiro-4")
        res = run_human_layers(ctx, env=ON)
        rep = json.loads((ctx.work_dir / "human" / "report.json").read_text())
        self.assertEqual(rep["errors"], {})
        for k in ("humanModel", "priors", "playerTypes", "openData", "adaptation", "ranking"):
            self.assertFalse(res.layers[k]["on"], k)
        self.assertIsNone(res.human_model)
        self.assertIsNone(res.human_model_report)
        self.assertIsNone(res.summary["playerTypes"])
        self.assertFalse((ctx.work_dir / "human" / "model").exists(), "no training below the threshold")
        self.assertFalse((ctx.work_dir / "human" / "open-data").exists())
        pri = formats.load("zap-priors/1", s3.buckets[ctx.config.storage["models_bucket"]]["control/priors.json"]["body"])
        self.assertEqual(pri["source"], "selfplay")
        self.assertIsNone(pri["people"])
        self.assertTrue(res.layers["flags"]["on"], "flags run every cycle with an export")
        self.assertEqual(s3.json(ctx.config.storage["models_bucket"], flags.FLAGS_KEY)["ops"], [])

    def test_no_tables_no_export(self):
        ctx, _, _, _ = new_context()
        res = run_human_layers(ctx, env=ON)
        self.assertTrue(all(not v["on"] for v in res.layers.values()))
        self.assertIsNone(res.human_model)

    def test_a_failed_layer_publishes_a_fixed_reason(self):
        # summary.json is public: the exception's text (a path, a token) stays in the log and the report.
        ctx, _, _, _ = new_context()
        with mock.patch.object(flags, "run_flags", side_effect=RuntimeError("/srv/private/path tok_secret")):
            res = run_human_layers(ctx, env=ON)
        rep = json.loads((ctx.work_dir / "human" / "report.json").read_text())
        self.assertEqual(res.layers["flags"]["why"], FAILED_WHY)
        self.assertNotIn("tok_secret", json.dumps(res.layers))
        self.assertIn("tok_secret", rep["errors"]["flags"])


if __name__ == "__main__":
    unittest.main()
