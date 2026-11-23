"""Open data: what may go in (linked, not opted out, not flagged, cells of 20 people or more), new
codes per match, the style figures, the switch, and the GitHub upload as a dry run that never
opens a connection."""

import io
import json
import socket
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from zapcycle.errors import GuardError
from zapcycle import human
from zapcycle.human import github, opendata

from .human_support import DAY, HOUR, T0, Tables, group, new_context


def cell_tables(n_people: int, week_offset_days: int = 0, seg: str = "paulista-2", salt: str = "p", t: Tables | None = None, **flags) -> Tables:
    t = t or Tables()
    for i in range(n_people):
        t.match(group(i, salt), T0 + week_offset_days * DAY + 15 * HOUR + i * 60_000, [(0, 900)] * 5, seg=seg, **flags)
    return t


class SelectTest(unittest.TestCase):
    def test_cells_need_20_people(self):
        t = cell_tables(20)
        cell_tables(19, seg="mineiro-4", salt="q", t=t)
        chosen, cells = opendata.select(t.lines, set(), 20)
        self.assertEqual([(c["variant"], c["players"], c["people"]) for c in cells], [("paulista", 2, 20)])
        self.assertEqual(len(chosen), 20)
        keys = {c["key"] for c in chosen}
        self.assertTrue(all(line["key"] in keys for line in t.lines[:20]))
        self.assertFalse(any(line["key"] in keys for line in t.lines[20:]))

    def test_the_floor_of_20_holds_under_test_thresholds(self):
        ctx, _, _, _ = new_context()
        ctx.config = ctx.config.with_values("thresholds", min_cell_people=1)
        self.assertEqual(opendata.min_cell(ctx), 20)
        chosen, cells = opendata.select(cell_tables(5).lines, set(), opendata.min_cell(ctx))
        self.assertEqual(chosen, [])
        self.assertEqual(cells, [])

    def test_opted_out_unlinked_and_flagged_matches_stay_out(self):
        t = cell_tables(25)
        t.lines[0]["humans"][0]["openDataOptOut"] = True
        t.lines[1]["humans"][0]["group"] = None  # deleted data: no export row
        t.lines[2]["humans"][0]["flagged"] = True
        t.lines[3]["humans"][0]["weight"] = 0
        chosen, cells = opendata.select(t.lines, {t.lines[4]["humans"][0]["group"]}, 20)
        keys = {c["key"] for c in chosen}
        for i in range(5):
            self.assertNotIn(t.lines[i]["key"], keys)
        self.assertEqual(len(chosen), 20)
        self.assertEqual(cells[0]["people"], 20)

    def test_a_match_with_one_opted_out_person_leaves_whole(self):
        t = cell_tables(21)
        line = t.lines[0]
        line["humans"].append({**line["humans"][0], "seat": 2, "group": group(99), "openDataOptOut": True})
        chosen, _ = opendata.select(t.lines, set(), 20)
        self.assertNotIn(line["key"], {c["key"] for c in chosen})

    def test_new_codes(self):
        chosen, _ = opendata.select(cell_tables(30).lines, set(), 20)
        codes = [c["code"] for c in chosen]
        self.assertEqual(len(set(codes)), 30)
        self.assertTrue(all(len(c) == 16 and int(c, 16) >= 0 for c in codes))
        again, _ = opendata.select(cell_tables(30).lines, set(), 20)
        self.assertEqual(set(codes) & {c["code"] for c in again}, set(), "a new code every time")
        self.assertEqual(codes, sorted(codes), "rows are ordered by code, not by time")
        self.assertEqual({c["week"] for c in chosen}, {"2026-W45"})

    def test_weeks_split_cells(self):
        t = cell_tables(20)
        cell_tables(20, week_offset_days=7, salt="w", t=t)
        _, cells = opendata.select(t.lines, set(), 20)
        self.assertEqual([c["week"] for c in cells], ["2026-W45", "2026-W46"])


class StyleTest(unittest.TestCase):
    def readings(self, n, matches=60):
        return [{"group": group(i), "matches": matches, "decisions": 900, "shown": True, "values": [0.123, 0.4, 0.5, 0.1, 0.3, 0.2, 0.05, 0.9]} for i in range(n)]

    def test_aggregates_only(self):
        self.assertEqual(opendata.style_rows(self.readings(19), set(), set(), 50), [])
        rows = opendata.style_rows(self.readings(25), {group(0)}, {group(1)}, 50)
        self.assertEqual(len(rows), 1, "one row per band of match counts, never one per person")
        r = rows[0]
        self.assertEqual(set(r), set(opendata.STYLE_COLUMNS))
        self.assertEqual((r["matches_band"], r["people"]), ("from 50 to 99", 23))
        self.assertEqual((r["raise_mean"], r["raise_sd"]), (0.12, 0.0))
        self.assertEqual(opendata.style_rows(self.readings(25, matches=49), set(), set(), 50), [])

    def test_bands_and_numbers_below_20_people_stay_out(self):
        rs = self.readings(21) + [dict(x, matches=250, group=group(i, "q")) for i, x in enumerate(self.readings(5))]
        for i, x in enumerate(rs[:3]):
            x["values"] = [0.1 * (i + 1), 0.4, 0.5, 0.1, 0.3, 0.2, 0.05, None]
        rows = opendata.style_rows(rs, set(), set(), 50)
        self.assertEqual([(r["matches_band"], r["people"]) for r in rows], [("from 50 to 99", 21)])
        self.assertEqual((rows[0]["signalTruth_mean"], rows[0]["signalTruth_sd"]), (None, None), "18 people with the number shown")
        xs = [0.1, 0.2, 0.3] + [0.123] * 18
        mean = sum(xs) / 21
        self.assertEqual(rows[0]["raise_mean"], round(mean, 2))
        self.assertEqual(rows[0]["raise_sd"], round((sum((x - mean) ** 2 for x in xs) / 20) ** 0.5, 2))


class UploadTest(unittest.TestCase):
    """open-data --upload sends only a package built from the newest export."""

    EXPORT = {"date": "2026-11-09", "sha256": "a" * 64, "key": "exports/2026-11-09.json", "etag": "e"}

    def package(self, ctx, export_sha: str | None) -> None:
        d = ctx.work_dir / "human" / "open-data"
        (d / "package").mkdir(parents=True, exist_ok=True)
        (d / f"zap-open-data-{ctx.cycle_id}.zip").write_bytes(b"PK zip bytes")
        m = {"schema": "zap-open-data/1", "created": "2026-11-09", "release": f"open-data-{ctx.cycle_id}", "license": "CC-BY-4.0", "test": True, "matches": 25, "decisions": 125, "cells": 1, "minPeoplePerCell": 20, "stylePeople": 0}
        if export_sha is not None:
            m.update(exportDate="2026-11-09", exportSha256=export_sha)
        (d / "package" / "manifest.json").write_text(json.dumps(m))

    def context(self):
        ctx, _, _, _ = new_context()  # now: 2026-11-09 00:00 UTC
        ctx.config = ctx.config.with_values("thresholds", open_data_matches=1)
        cell_tables(25).write(ctx)
        return ctx

    def upload(self, ctx):
        args = mock.Mock(upload=True)
        with mock.patch("sys.stderr", new=io.StringIO()):
            return human.command("open-data", ctx, args, env={"OPEN_DATA_ENABLED": "true"})

    def test_a_package_from_an_older_export_is_refused(self):
        ctx = self.context()
        ctx.state["latestExport"] = dict(self.EXPORT, sha256="b" * 64, date="2026-11-10")
        self.package(ctx, "a" * 64)
        with self.assertRaises(GuardError) as e:
            self.upload(ctx)
        self.assertIn("older export", str(e.exception))
        # A package made before this rule (no export recorded) is refused too.
        self.package(ctx, None)
        with self.assertRaises(GuardError):
            self.upload(ctx)

    def test_a_stale_export_is_refused_and_a_fresh_one_goes_through(self):
        ctx = self.context()
        ctx.state["latestExport"] = dict(self.EXPORT)
        self.package(ctx, "a" * 64)
        ctx.now_ms += 2 * DAY + HOUR
        with self.assertRaises(GuardError) as e:
            self.upload(ctx)
        self.assertIn("more than a day old", str(e.exception))
        ctx.now_ms -= 2 * DAY
        out = self.upload(ctx)
        self.assertTrue(out["upload"]["dryRun"])
        self.assertEqual([q["method"] for q in out["upload"]["requests"]], ["GET", "POST", "POST"])

    def test_check_fresh(self):
        m = {"exportDate": "2026-11-09", "exportSha256": "a" * 64}
        now = T0 + 7 * DAY + 10 * HOUR
        opendata.check_fresh(m, self.EXPORT, now)
        opendata.check_fresh(m, self.EXPORT, now + DAY)
        with self.assertRaises(GuardError):
            opendata.check_fresh(m, self.EXPORT, now + 2 * DAY)
        with self.assertRaises(GuardError):
            opendata.check_fresh(m, None, now)


class AfterPromotionTest(unittest.TestCase):
    """After a promotion the cycle releases on its own (cli.open_data_after_promotion), once the owner
    made the first release by hand; dry runs only in the local profiles."""

    NOW = T0 + 7 * DAY + 10 * HOUR  # 2026-11-09 10:00 UTC
    ON = {"OPEN_DATA_ENABLED": "true"}

    def setUp(self):
        from zapcycle import cli

        from .helpers import fake_cycle, temp_config

        self.cli = cli
        cfg, _ = temp_config("test", thresholds={"open_data_matches": 1})
        self.cyc, _ = fake_cycle(cfg, clock=lambda: self.NOW)
        self.cid = "20261109-0100"
        self.ctx = cli.context(self.cyc, self.cid)
        cell_tables(25).write(self.ctx)
        self.cyc.state["latestExport"] = dict(UploadTest.EXPORT)
        self.st = cli.Steps(self.cyc, self.cid, self.NOW)

    def run_hook(self, env):
        with mock.patch.object(self.cli, "sync", return_value=None) as sync, mock.patch("sys.stderr", new=io.StringIO()):
            out = self.cli.open_data_after_promotion(self.cyc, self.st, env)
        return out, sync

    def test_off_by_default_and_nothing_synced(self):
        out, sync = self.run_hook({})
        self.assertEqual(out["status"], "off")
        self.assertIn("OPEN_DATA_ENABLED", out["why"])
        sync.assert_not_called()

    def test_first_release_by_hand_then_on_its_own(self):
        UploadTest.package(None, self.ctx, "a" * 64)
        out, sync = self.run_hook(self.ON)
        sync.assert_called_once()
        self.assertEqual((out["status"], out["rebuilt"]), ("waiting", False))
        self.assertEqual(self.cyc.state["openDataReleases"], [])
        # The owner's first release (a dry run in the test profile), then the cycle's own.
        with mock.patch("sys.stderr", new=io.StringIO()):
            human.command("open-data", self.cli.context(self.cyc, self.cid), mock.Mock(upload=True), env=self.ON)
        out, _ = self.run_hook(self.ON)
        self.assertEqual(out["status"], "uploaded")
        self.assertTrue(out["upload"]["dryRun"])
        self.assertEqual([q["method"] for q in out["upload"]["requests"]], ["GET", "POST", "POST"])
        self.assertEqual([(r["auto"], r["dryRun"]) for r in self.cyc.state["openDataReleases"]], [(False, True), (True, True)])
        # A dry run never counts as the first real release.
        self.assertFalse(human.first_release_done(self.ctx, False))

    def test_a_newer_export_builds_tables_readings_and_package_again(self):
        UploadTest.package(None, self.ctx, "a" * 64)
        self.cyc.state["openDataReleases"] = [{"release": "open-data-20261102-0100", "sha256": "c" * 64, "exportDate": "2026-11-02", "matches": 25, "at": 1, "dryRun": True, "auto": False}]
        self.cyc.state["latestExport"] = dict(UploadTest.EXPORT, sha256="b" * 64)
        calls = []

        def rebuilt_package(ctx, exclude, readings, summary, env):
            calls.append("package")
            UploadTest.package(None, ctx, "b" * 64)
            return {"on": True, "why": "", "progress": {}}, {}

        with mock.patch.object(self.cli, "run_build", side_effect=lambda *a, **k: calls.append("build")), mock.patch("zapcycle.human.priors.run_profiles", side_effect=lambda *a: calls.append("profiles")), mock.patch("zapcycle.human.opendata.run_open_data", side_effect=rebuilt_package):
            out, _ = self.run_hook(self.ON)
        self.assertEqual(calls, ["build", "profiles", "package"])
        self.assertEqual((out["status"], out["rebuilt"]), ("uploaded", True))
        self.assertEqual(self.cyc.state["openDataReleases"][-1]["auto"], True)

    def test_a_cycle_without_tables_builds_them(self):
        # adopt makes a cycle with no tables of its own: the release builds them from the newest export.
        import shutil

        shutil.rmtree(self.ctx.tables_dir)
        self.cyc.state["openDataReleases"] = [{"release": "x", "sha256": "c" * 64, "exportDate": "2026-11-02", "matches": 25, "at": 1, "dryRun": True, "auto": False}]
        ctx = self.ctx

        def build(*a, **k):
            cell_tables(25).write(ctx)

        def package(c, exclude, readings, summary, env):
            UploadTest.package(None, c, "a" * 64)
            return opendata.gate(c, summary, env), {}

        with mock.patch.object(self.cli, "run_build", side_effect=build), mock.patch("zapcycle.human.priors.run_profiles"), mock.patch("zapcycle.human.opendata.run_open_data", side_effect=package):
            out, _ = self.run_hook(self.ON)
        self.assertEqual((out["status"], out["rebuilt"]), ("uploaded", True))
        # Without tables and with the switch off, nothing is built.
        shutil.rmtree(self.ctx.tables_dir)
        with mock.patch.object(self.cli, "run_build") as rb:
            out, _ = self.run_hook({})
        self.assertEqual(out["status"], "off")
        rb.assert_not_called()

    def test_a_failure_never_raises(self):
        UploadTest.package(None, self.ctx, "a" * 64)
        self.cyc.state["openDataReleases"] = [{"release": "x", "sha256": "c" * 64, "exportDate": "2026-11-02", "matches": 25, "at": 1, "dryRun": True, "auto": False}]
        self.NOW += 3 * DAY  # the newest export (2026-11-09) is now 3 days old
        out, _ = self.run_hook(self.ON)
        self.assertEqual(out["status"], "failed")
        self.assertIn("more than a day old", out["error"])


class SwitchTest(unittest.TestCase):
    def test_off_by_default(self):
        self.assertFalse(opendata.enabled({}))
        self.assertFalse(opendata.enabled({"OPEN_DATA_ENABLED": "false"}))
        self.assertTrue(opendata.enabled({"OPEN_DATA_ENABLED": "true"}))
        ctx, _, _, _ = new_context()
        lay, rep = opendata.run_open_data(ctx, set(), [], {"validMatches": 10**6}, env={})
        self.assertFalse(lay["on"])
        self.assertIn("OPEN_DATA_ENABLED", lay["why"])
        lay, _ = opendata.run_open_data(ctx, set(), [], {"validMatches": 999}, env={"OPEN_DATA_ENABLED": "true"})
        self.assertFalse(lay["on"])
        self.assertEqual(lay["progress"], {"matches": 999, "matchesNeeded": 1000})


class GithubDryRunTest(unittest.TestCase):
    def test_prints_the_requests_and_never_connects(self):
        z = Path(tempfile.mkdtemp()) / "zap-open-data-20261109-2200.zip"
        z.write_bytes(b"PK zip bytes")
        out = io.StringIO()
        dry = github.DryRun(out)
        boom = mock.Mock(side_effect=AssertionError("a connection was opened"))
        with mock.patch.object(socket, "create_connection", boom), mock.patch.object(urllib.request, "urlopen", boom):
            r = github.publish_release("AndreiLud/zap", "open-data-20261109-2200", "Zap open data", "notes", z, "github_pat_SECRET", dry)
        boom.assert_not_called()
        self.assertEqual(r, {"tag": "open-data-20261109-2200", "created": True, "uploaded": True, "asset": z.name})
        self.assertEqual([q["method"] for q in dry.requests], ["GET", "POST", "POST"])
        self.assertTrue(dry.requests[0]["url"].endswith("/repos/AndreiLud/zap/releases/tags/open-data-20261109-2200"))
        self.assertEqual(dry.requests[1]["body"]["tag_name"], "open-data-20261109-2200")
        self.assertIn("?name=zap-open-data-20261109-2200.zip", dry.requests[2]["url"])
        self.assertEqual(dry.requests[2]["bodyBytes"], 12)
        printed = out.getvalue()
        self.assertNotIn("SECRET", printed)
        self.assertNotIn("SECRET", json.dumps(dry.requests))
        self.assertIn("Bearer ***", printed)

    def test_guards(self):
        z = Path(tempfile.mkdtemp()) / "a.zip"
        z.write_bytes(b"x")
        dry = github.DryRun(io.StringIO())
        with self.assertRaises(GuardError):
            github.publish_release("AndreiLud/zap", "open-data-20261109-2200", "t", "n", z, "", dry)
        with self.assertRaises(Exception):
            github.publish_release("not a repo", "open-data-20261109-2200", "t", "n", z, "tok", dry)
        with self.assertRaises(Exception):
            github.publish_release("AndreiLud/zap", "v1", "t", "n", z, "tok", dry)
        self.assertEqual(dry.requests, [])


if __name__ == "__main__":
    unittest.main()
