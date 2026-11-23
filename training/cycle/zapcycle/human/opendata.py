"""Open data package (contract 3.11; plan section 7). Off unless OPEN_DATA_ENABLED is "true" and the
cycle has at least `open_data_matches` valid matches.

What goes in, and why it cannot point to a person:
* only matches whose every person's seat is still linked in D1 (people who deleted their data have
  no export row), not opted out ("Fora dos dados abertos"), not flagged, and not flagged by this
  cycle either;
* each match gets a new random code (16 hex characters from the operating system's generator),
  unrelated to the match id and to the codes of any other release, so no row links two matches by
  the same person;
* dates only as the ISO week of the match end; a person's decision time only as a 0.5 s band;
* cells (week, variant, players) are published only with at least 20 distinct people; matches of
  smaller cells are left out whole. The floor of 20 holds whatever the thresholds say;
* no match id, seed, group token, room code, nickname, device or pseudonym anywhere;
* style figures are aggregates, never one row per person: per band of match counts, over the people
  of that band with at least `open_data_style_matches` matches (at least 20 of them), the mean and
  the standard deviation of each reading number (posterior means under the fitted priors, 2
  decimals), with no link to any match;
* the package records the export it was built from (date and SHA-256). `open-data --upload` syncs
  first and refuses a package built from an older export, or when the newest export is more than a
  day old, so a person who deleted their data or left open data after the package was built is
  never published.

The package is a zip in the cycle's work folder with matches.csv, decisions.csv, cells.csv,
style.csv, DICTIONARY.md, LICENSE.md (CC BY 4.0) and manifest.json. `open-data --upload` attaches
it to a GitHub release of the repository with the fine-grained GITHUB_RELEASES_TOKEN; in the local
profiles, and whenever the switch is off, the upload is a dry run that prints the requests and
opens no connection."""

from __future__ import annotations

import hashlib
import json
import math
import os
import secrets
import shutil
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from ..config import ROOT
from ..context import CycleContext
from ..errors import GuardError
from .common import MIN_PEOPLE, READING_KEYS, layer, node, people, record_lines, records_dir, section, work

TEMPLATE_DIR = ROOT / "training" / "cycle" / "opendata"
DEFAULTS = {"repo": "", "time_bin_ms": 500, "max_time_s": 120}
FILES = ("matches.csv", "decisions.csv", "cells.csv", "style.csv", "DICTIONARY.md", "LICENSE.md", "manifest.json")


def settings(ctx: CycleContext) -> dict:
    return {**DEFAULTS, **section(ctx, "open_data")}


def enabled(env: dict | None = None) -> bool:
    env = os.environ if env is None else env
    return env.get("OPEN_DATA_ENABLED", "false").strip().lower() == "true"


def iso_week(ms: int) -> str:
    y, w, _ = datetime.fromtimestamp(ms / 1000, timezone.utc).isocalendar()
    return f"{y}-W{w:02d}"


def min_cell(ctx: CycleContext) -> int:
    return max(MIN_PEOPLE, int(ctx.config.thresholds["min_cell_people"]))


def eligible(line: dict, exclude: set[str]) -> bool:
    hs = line["humans"]
    return bool(hs) and all(h.get("group") and not h["flagged"] and not h["openDataOptOut"] and (h.get("weight") or 0) > 0 and h["group"] not in exclude for h in hs)


def select(lines: list[dict], exclude: set[str], cell_min: int) -> tuple[list[dict], list[dict]]:
    """The matches of the package with their new codes, and the published cells."""
    cells: dict[tuple, dict] = defaultdict(lambda: {"people": set(), "keys": []})
    for line in lines:
        if not eligible(line, exclude):
            continue
        variant, players = line["segment"].split("-")
        c = cells[(iso_week(line["endedAt"]), variant, int(players))]
        c["people"].update(h["group"] for h in line["humans"])
        c["keys"].append(line["key"])
    chosen: list[dict] = []
    published: list[dict] = []
    for (week, variant, players), c in sorted(cells.items()):
        if len(c["people"]) < max(MIN_PEOPLE, cell_min):
            continue
        published.append({"week": week, "variant": variant, "players": players, "people": len(c["people"]), "matches": len(c["keys"])})
        chosen.extend({"key": k, "code": secrets.token_hex(8), "week": week} for k in c["keys"])
    chosen.sort(key=lambda s: s["code"])
    return chosen, published


STYLE_COLUMNS = ["matches_band", "people", *(f"{k}_{s}" for k in READING_KEYS for s in ("mean", "sd"))]


def bands(min_matches: int) -> list[tuple[str, int, int | None]]:
    """The match count bands of the style figures: (name, from, to or None)."""
    return [
        (f"from {min_matches} to {2 * min_matches - 1}", min_matches, 2 * min_matches - 1),
        (f"from {2 * min_matches} to {4 * min_matches - 1}", 2 * min_matches, 4 * min_matches - 1),
        (f"{4 * min_matches} or more", 4 * min_matches, None),
    ]


def style_rows(readings: list[dict], opted_out: set[str], exclude: set[str], min_matches: int) -> list[dict]:
    """One row per band of match counts with at least 20 people: the people count, and for each
    reading number the mean and the standard deviation over the people of the band whose number is
    shown (empty when fewer than 20 of them). No value of one person appears on its own."""
    groups: dict[str, list[list]] = defaultdict(list)
    for r in readings:
        if r["matches"] < min_matches or r["group"] in opted_out or r["group"] in exclude:
            continue
        name = next(b for b, lo, hi in bands(min_matches) if r["matches"] >= lo and (hi is None or r["matches"] <= hi))
        groups[name].append(r["values"])
    rows = []
    for name, _, _ in bands(min_matches):
        vals = groups.get(name, [])
        if len(vals) < MIN_PEOPLE:
            continue
        row: dict = {"matches_band": name, "people": len(vals)}
        for i, key in enumerate(READING_KEYS):
            xs = [float(v[i]) for v in vals if v[i] is not None]
            if len(xs) < MIN_PEOPLE:
                row[f"{key}_mean"] = row[f"{key}_sd"] = None
                continue
            mean = sum(xs) / len(xs)
            row[f"{key}_mean"] = round(mean, 2)
            row[f"{key}_sd"] = round(math.sqrt(sum((x - mean) ** 2 for x in xs) / (len(xs) - 1)), 2)
        rows.append(row)
    return rows


def _csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    def f(v) -> str:
        return "" if v is None else str(v)

    path.write_text(",".join(columns) + "\n" + "".join(",".join(f(r[c]) for c in columns) + "\n" for r in rows))


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def built_from(ctx: CycleContext) -> dict:
    """The export the cycle's tables were built from (tables/data.json), else the newest synced one."""
    p = ctx.tables_dir / "data.json"
    d = json.loads(p.read_text()) if p.exists() else {}
    if d.get("exportSha256"):
        return {"date": d["exportDate"], "sha256": d["exportSha256"]}
    ex = ctx.state.get("latestExport") or {}
    return {"date": ex.get("date"), "sha256": ex.get("sha256")}


def check_fresh(m: dict, latest: dict | None, now_ms: int) -> None:
    """Refuses to upload a package built from an export older than the newest one sync found, or when
    the newest export is more than a day old: a person who deleted their data or left open data
    after the package was built must not be published."""
    again = "run sync, build and open-data again, look inside the zip, then upload"
    if not latest or not m.get("exportSha256") or m["exportSha256"] != latest.get("sha256"):
        raise GuardError(f"the package was built from an older export; {again}")
    today = datetime.fromtimestamp(now_ms / 1000, timezone.utc).date()
    if (today - datetime.fromisoformat(m["exportDate"]).date()).days > 1:
        raise GuardError(f"the newest export ({m['exportDate']}) is more than a day old; wait for the daily export, then {again}")


def build_package(ctx: CycleContext, exclude: set[str], readings: list[dict]) -> dict:
    s = settings(ctx)
    source = built_from(ctx)
    lines = record_lines(ctx)
    chosen, cells = select(lines, exclude, min_cell(ctx))
    out = work(ctx) / "open-data"
    if out.exists():
        shutil.rmtree(out)
    pkg = out / "package"
    pkg.mkdir(parents=True)
    sel = out / "selection.jsonl"
    sel.write_text("".join(json.dumps(c) + "\n" for c in chosen))
    rows = node(ctx, "opendata.ts", "--records", str(records_dir(ctx)), "--selection", str(sel), "--out", str(pkg), "--time-bin-ms", str(int(s["time_bin_ms"])), "--max-time-s", str(int(s["max_time_s"])))
    sel.unlink()  # the link from codes to match ids lives only while the rows are written
    _csv(pkg / "cells.csv", ["week", "variant", "players", "people", "matches"], cells)
    opted = {h["group"] for line in lines for h in line["humans"] if h.get("group") and h["openDataOptOut"]}
    style = style_rows(readings, opted, exclude, int(ctx.config.thresholds["open_data_style_matches"]))
    _csv(pkg / "style.csv", STYLE_COLUMNS, style)
    created = datetime.fromtimestamp(ctx.now_ms / 1000, timezone.utc).strftime("%Y-%m-%d")
    dictionary = (TEMPLATE_DIR / "DICTIONARY.md").read_text()
    (pkg / "DICTIONARY.md").write_text(dictionary.replace("{created}", created).replace("{min_people}", str(min_cell(ctx))).replace("{style_matches}", str(int(ctx.config.thresholds["open_data_style_matches"]))))
    shutil.copy(TEMPLATE_DIR / "LICENSE.md", pkg / "LICENSE.md")
    manifest = {
        "schema": "zap-open-data/1",
        "created": created,
        "release": f"open-data-{ctx.cycle_id}",
        "license": "CC-BY-4.0",
        "test": ctx.config.mode != "r2",
        "matches": rows["matches"],
        "decisions": rows["decisions"],
        "cells": len(cells),
        "minPeoplePerCell": min_cell(ctx),
        "stylePeople": sum(r["people"] for r in style),
        "exportDate": source["date"],
        "exportSha256": source["sha256"],
        "files": {f: sha256_file(pkg / f) for f in FILES if f != "manifest.json"},
    }
    (pkg / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    zpath = out / f"zap-open-data-{ctx.cycle_id}.zip"
    with zipfile.ZipFile(zpath, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            z.write(pkg / f, f"zap-open-data-{ctx.cycle_id}/{f}")
    return {"zip": str(zpath), "sha256": sha256_file(zpath), "manifest": manifest}


def gate(ctx: CycleContext, summary: dict, env: dict | None = None) -> dict:
    """The layer's state from the switch and the threshold, without building anything."""
    need = int(ctx.config.thresholds["open_data_matches"])
    vm = int(summary.get("validMatches") or 0)
    progress = {"matches": vm, "matchesNeeded": need}
    if not enabled(env):
        return layer(False, "Switched off until the owner sets OPEN_DATA_ENABLED to true.", **progress)
    if vm < need:
        return layer(False, f"Waits for {need} valid matches.", **progress)
    return layer(True, "", **progress)


def run_open_data(ctx: CycleContext, exclude: set[str], readings: list[dict], summary: dict, env: dict | None = None) -> tuple[dict, dict]:
    state = gate(ctx, summary, env)
    progress = state["progress"]
    if not state["on"]:
        return state, {"on": False}
    pkg = build_package(ctx, exclude, readings)
    m = pkg["manifest"]
    why = "A package is ready for the release: matches with new codes, weeks, decision times in 0.5 s bands, cells of at least 20 people, CC BY 4.0."
    if m["matches"] == 0:
        why = "On, but no cell reached 20 people yet, so the package holds no match."
    return layer(True, why, **progress), pkg


def latest_package(ctx: CycleContext) -> tuple[Path, dict] | None:
    """The zip the newest cycle built (the one the owner can look at) and its manifest."""
    d = work(ctx) / "open-data"
    z = sorted(d.glob("zap-open-data-*.zip")) if d.is_dir() else []
    m = d / "package" / "manifest.json"
    if not z or not m.exists():
        return None
    return z[-1], json.loads(m.read_text())
