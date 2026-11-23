"""Pieces shared by the human layers: the decision tables of the cycle, the latest export, the Node
tools, the people count rule and the shape of a layer in summary.layers."""

from __future__ import annotations

import gzip
import json
import math
from pathlib import Path
from typing import Any, Iterator

from .. import proc
from ..context import CycleContext
from ..logs import run_log_path

# A number built from people appears only for a cell of at least this many distinct people
# (contract 1.10). It is a floor: no setting lowers it, not even the test thresholds.
MIN_PEOPLE = 20
NODE_DIR = "training/cycle/node/human"
DEFAULT_PRIORS = "shared/profile-priors-default.json"
READING_KEYS = ("raise", "run", "accept", "reraise", "shown", "cover", "bluff", "signalTruth")
DECISION_TYPES = ("answer", "onze", "bet", "card")


def people(n: int | None) -> int | None:
    """A people count as public files may show it: null under MIN_PEOPLE."""
    return None if n is None or n < MIN_PEOPLE else int(n)


def layer(on: bool, why: str, **progress: int | None) -> dict:
    """One entry of summary.layers: progress holds match counts and people counts (null under 20)."""
    return {"on": bool(on), "why": " ".join(why.split())[:500], "progress": {k: (None if v is None else int(v)) for k, v in progress.items()}}


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def iter_jsonl(path: Path) -> Iterator[dict]:
    if not path.exists():
        return
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def tables_summary(ctx: CycleContext) -> dict:
    p = ctx.tables_dir / "summary.json"
    return json.loads(p.read_text()) if p.exists() else {}


def record_lines(ctx: CycleContext) -> list[dict]:
    """tables/records.jsonl; the position of a line is the `m` of the decision rows."""
    return read_jsonl(ctx.tables_dir / "records.jsonl")


def decision_rows(ctx: CycleContext) -> Iterator[dict]:
    return iter_jsonl(ctx.tables_dir / "decisions.jsonl.gz")


def latest_export(ctx: CycleContext) -> dict | None:
    """The newest complete daily export that sync kept (data/<profile>/exports/latest.json)."""
    p = ctx.data_dir / "exports" / "latest.json"
    if not p.exists():
        return None
    ex = json.loads(p.read_text())
    return None if ex.get("partial") else ex


def records_dir(ctx: CycleContext) -> Path:
    return ctx.data_dir / "records"


def work(ctx: CycleContext) -> Path:
    d = ctx.work_dir / "human"
    d.mkdir(parents=True, exist_ok=True)
    return d


def store(ctx: CycleContext) -> Path:
    """data/<profile>/human/: what outlives a cycle (the human model, the flag operations)."""
    d = ctx.data_dir / "human"
    d.mkdir(parents=True, exist_ok=True)
    return d


def log_path(ctx: CycleContext) -> Path:
    return run_log_path(ctx.config.logs_dir, ctx.cycle_id)


def node(ctx: CycleContext, tool: str, *args: str) -> dict:
    """Runs a Node tool of node/human/ and returns the JSON line it prints last."""
    cmd = ["node", f"{NODE_DIR}/{tool}", *args]
    return proc.last_json_line(proc.run(cmd, log_path(ctx), env={"ZAP_FACTS": str(ctx.work_dir / "facts-scratch.json")}))


def write_groups(path: Path, groups: set[str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(f"{g}\n" for g in sorted(groups)))
    return path


def section(ctx: CycleContext, name: str) -> dict:
    """A table of [human] in the config ([human.flags] and so on)."""
    v = ctx.config.human.get(name, {})
    return v if isinstance(v, dict) else {}


def logit(p: float) -> float:
    p = min(0.999, max(0.001, p))
    return math.log(p / (1 - p))


def dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)
