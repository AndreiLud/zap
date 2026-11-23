"""Support for the human layer tests: a CycleContext over a temporary profile with the in-memory S3
of helpers.py, and decision tables written directly (synthetic people, no Node) or made by the
Node tools from synthetic records (node/human/synth.ts, then node/build.ts)."""

from __future__ import annotations

import gzip
import json
import logging
import math
import random
import shutil
import subprocess
from pathlib import Path

from zapcycle.config import ROOT
from zapcycle.context import CycleContext

from .helpers import fake_cycle, temp_config

DAY = 86_400_000
HOUR = 3_600_000
T0 = 1_793_577_600_000  # 2026-11-02 00:00 UTC, a Monday


def context(cfg, s3=None, now: int = T0 + 7 * DAY, cycle_id: str = "20261109-2200"):
    cyc, s3 = fake_cycle(cfg, s3)
    work = cfg.work_dir / cycle_id
    work.mkdir(parents=True, exist_ok=True)
    log = logging.getLogger("zapcycle.test.human")
    log.addHandler(logging.NullHandler())
    log.propagate = False
    ctx = CycleContext(
        config=cfg, profile=cfg.profile, cycle_id=cycle_id, now_ms=now, data_dir=cfg.data_dir, work_dir=work, tables_dir=work / "tables",
        events=cyc.events, models=cyc.models, public=cyc.public, log=log, state=cyc.state,
    )
    return ctx, cyc, s3


def new_context(now: int = T0 + 7 * DAY, **sections):
    cfg, tmp = temp_config("test", **sections)
    ctx, cyc, s3 = context(cfg, now=now)
    return ctx, cyc, s3, tmp


class Tables:
    """records.jsonl and decisions.jsonl.gz as build.ts writes them, for synthetic people."""

    def __init__(self):
        self.lines: list[dict] = []
        self.rows: list[dict] = []
        self.export_rows: list[dict] = []

    def match(self, group: str | None, started: int, decisions: list[tuple[int, int | None]], seg: str = "paulista-2", seat: int = 0, flagged=False, opt_out=False, no_adapt=False, kind="solo1", legal: int = 0b111, auto=False) -> int:
        m = len(self.lines)
        mid = f"{m:08x}-0000-4000-8000-{m:012x}"
        self.lines.append({
            "key": f"matches/v1/x/{mid}.json", "matchId": mid, "kind": kind, "segment": seg, "startedAt": started, "endedAt": started + 600_000, "test": True,
            "arm": None, "aiVersion": "v1", "partnerVersion": "v1", "winner": 0,
            "humans": [{"seat": seat, "group": group, "weight": (0 if flagged else 1) if group else None, "flagged": flagged, "openDataOptOut": opt_out, "noAdapt": no_adapt, "verified": True, "abandoned": False}],
        })
        for i, (a, ms) in enumerate(decisions):
            self.rows.append({"m": m, "i": 2 * i + 1, "seat": seat, "hand": i // 3, "type": "card", "legal": legal, "a": a, "ms": ms, "auto": auto, "group": group, "w": 0 if (flagged or not group) else 1})
        if group:
            self.export_rows.append({"matchId": mid, "seat": seat, "weight": 0 if flagged else 1, "flagged": flagged, "openDataOptOut": opt_out, "noAdapt": no_adapt, "group": group})
        return m

    def write(self, ctx: CycleContext, export_date: str = "2026-11-09", reports: list[dict] | None = None) -> None:
        t = ctx.tables_dir
        t.mkdir(parents=True, exist_ok=True)
        (t / "records.jsonl").write_text("".join(json.dumps(x) + "\n" for x in self.lines))
        with gzip.open(t / "decisions.jsonl.gz", "wt") as f:
            for r in self.rows:
                f.write(json.dumps(r) + "\n")
        groups = {h["group"] for x in self.lines for h in x["humans"] if h["group"]}
        (t / "summary.json").write_text(json.dumps({"records": len(self.lines), "valid": len(self.lines), "invalid": 0, "test": len(self.lines), "validMatches": len(self.lines), "linkedSeats": len(self.export_rows), "people": len(groups) if len(groups) >= 20 else None, "devices": len(groups), "decisions": len(self.rows), "weighted": len(self.rows), "excluded": {}}))
        ex = {"schema": "zap-export/1", "date": export_date, "createdAt": ctx.now_ms, "partial": False, "rows": self.export_rows, "reports": reports or []}
        d = ctx.data_dir / "exports"
        d.mkdir(parents=True, exist_ok=True)
        (d / "latest.json").write_text(json.dumps(ex))


def group(i: int, salt: str = "p") -> str:
    import hashlib

    return hashlib.sha256(f"{salt}{i}".encode()).hexdigest()[:16]


def person_decisions(rng: random.Random, n: int, median: float = 1200.0, sigma: float = 0.6) -> list[tuple[int, int]]:
    return [(rng.randrange(3), max(260, int(median * math.exp(sigma * rng.gauss(0, 1))))) for _ in range(n)]


def node(*args: str) -> str:
    r = subprocess.run(["node", *args], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"node {' '.join(args)} failed: {r.stderr[-2000:]}")
    return r.stdout


def synth_profile(ctx: CycleContext, tmp: Path, *synth_args: str) -> dict:
    """Synthetic records and export (synth.ts) mirrored into the profile, then the decision tables (build.ts)."""
    out = tmp / "synth"
    node("training/cycle/node/human/synth.ts", "--out", str(out), *synth_args)
    shutil.copytree(out / "records", ctx.data_dir / "records", dirs_exist_ok=True)
    (ctx.data_dir / "exports").mkdir(parents=True, exist_ok=True)
    shutil.copy(out / "export.json", ctx.data_dir / "exports" / "latest.json")
    cfg = json.dumps({"mode": ctx.config.mode, "deviceCap": ctx.config.data["device_cap"]})
    node("training/cycle/node/build.ts", "--records", str(ctx.data_dir / "records"), "--out", str(ctx.tables_dir), "--export", str(ctx.data_dir / "exports" / "latest.json"), "--config", cfg)
    return {"people": json.loads((out / "people.json").read_text()), "export": json.loads((out / "export.json").read_text())}
