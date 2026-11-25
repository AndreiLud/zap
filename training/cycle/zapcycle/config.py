"""Cycle configuration: training/cycle/config/{prod,local,test}.toml, read with tomllib.

Each file is complete (no inheritance). Paths in the files are relative to the project root.
ZAP_CYCLE_TEST_THRESHOLDS=1 divides every threshold by 25 (rounded up), only in minio mode.
"""

from __future__ import annotations

import math
import os
import re
import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .errors import CycleError
from .formats import MIN_PEOPLE

ROOT = Path(__file__).resolve().parents[3]

SECTIONS = ("storage", "paths", "schedule", "train", "gate", "ab", "data", "thresholds", "human", "explorer")
EXPLORER_LIMIT_MAX = 0.01  # the owner's 1 point (zapcycle/explorer.py LIMIT_MAX)
EXPLORER_INTS = ("threads", "round_pairs", "fresh_pairs", "trained_iters", "trained_decisions", "trained_workers", "trained_threads", "trained_eval_every", "trained_eval_pairs", "measure_pairs", "check_pairs", "style_matches")
# The sizes of _local/m6/run-feints.sh, the run whose verdict let the reading pass: in profile prod
# the step never measures with less (ROUND_PAIRS, PAIRS, X_PAIRS, X_ITERS, X_DECISIONS), searches the
# whole pool (GRID_LIMIT 0, --pool all). zapcycle/explorer.py promotable checks the sizes a step ran
# with against these too.
EXPLORER_PROD_MIN = {"round_pairs": 64, "fresh_pairs": 2000, "measure_pairs": 2000, "trained_iters": 103, "trained_decisions": 120000}
EXPLORER_PROD_EXACT = {"pool": "all", "grid_limit": 0}


def explorer_size_problems(x: dict) -> list[str]:
    """Where [explorer] sizes fall short of the run that passed (EXPLORER_PROD_MIN and EXPLORER_PROD_EXACT)."""
    out = [f"explorer.{k} must be at least {v} in profile prod (the size of _local/m6/run-feints.sh)" for k, v in EXPLORER_PROD_MIN.items() if not (isinstance(x.get(k), int) and not isinstance(x.get(k), bool) and x[k] >= v)]
    out += [f"explorer.{k} must be {v!r} in profile prod (the search of _local/m6/run-feints.sh)" for k, v in EXPLORER_PROD_EXACT.items() if x.get(k) != v or isinstance(x.get(k), bool)]
    return out


def mix_shares(mix: str) -> dict[str, float]:
    """A league mix ("kind=share,...") as shares by kind."""
    return {k: float(v) for k, v in (p.split("=", 1) for p in mix.split(",") if "=" in p)}
CLEARED_GRACE_DAYS = 15  # CLEARED_GRACE_MS of worker/src/cycle-jobs.ts in days (tests/test_config.py compares them)
PROFILES = ("prod", "local", "test")


def flat_keys(d: dict, prefix: str = "") -> set[str]:
    """Every key of a nested table as a dotted path (for the same-keys check of the three files)."""
    out: set[str] = set()
    for k, v in d.items():
        p = f"{prefix}{k}"
        out.add(p)
        if isinstance(v, dict):
            out |= flat_keys(v, p + ".")
    return out


@dataclass(frozen=True)
class Config:
    path: Path
    raw: dict
    profile: str
    storage: dict
    paths: dict
    schedule: dict
    train: dict
    gate: dict
    ab: dict
    data: dict
    thresholds: dict
    human: dict
    explorer: dict = field(default_factory=dict)
    root: Path = field(default=ROOT)

    @property
    def mode(self) -> str:
        return self.storage["mode"]

    def _abs(self, p: str) -> Path:
        q = Path(p)
        return q if q.is_absolute() else self.root / q

    @property
    def data_dir(self) -> Path:
        return self._abs(self.paths["data"])

    @property
    def work_dir(self) -> Path:
        return self._abs(self.paths["work"])

    @property
    def logs_dir(self) -> Path:
        return self._abs(self.paths["logs"])

    def with_paths(self, data: Path, work: Path, logs: Path) -> "Config":
        """A copy with other folders (tests point them at a temporary folder)."""
        return replace(self, paths={**self.paths, "data": str(data), "work": str(work), "logs": str(logs)})

    def with_values(self, section: str, **values: Any) -> "Config":
        return replace(self, **{section: {**getattr(self, section), **values}})


def _need(cond: bool, msg: str) -> None:
    if not cond:
        raise CycleError(f"config: {msg}")


def _check(c: Config) -> None:
    _need(c.profile in PROFILES, f"profile must be one of {PROFILES}")
    s = c.storage
    _need(s.get("mode") in ("r2", "minio"), "storage.mode must be r2 or minio")
    for k in ("endpoint", "events_bucket", "models_bucket", "public_bucket"):
        _need(isinstance(s.get(k), str), f"storage.{k} must be a string")
    b = s.get("bundled")
    _need(isinstance(b, list) and len(b) >= 1 and b[0] == "v1" and all(isinstance(v, str) and re.fullmatch(r"v[1-9][0-9]{0,5}", v) for v in b) and len(set(b)) == len(b), 'storage.bundled must list bundled versions, from "v1" on')
    _need(b == sorted(b, key=lambda v: int(v[1:])), "storage.bundled must be oldest first")
    for k in ("data", "work", "logs"):
        _need(isinstance(c.paths.get(k), str) and c.paths[k], f"paths.{k} must be a path")
    _need(isinstance(c.paths.get("keep_cycles"), int) and c.paths["keep_cycles"] >= 1, "paths.keep_cycles must be at least 1")
    sc = c.schedule
    _need(isinstance(sc.get("weekday"), int) and 0 <= sc["weekday"] <= 6, "schedule.weekday must be from 0 to 6")
    for k in ("time", "ab_check_utc"):
        _need(isinstance(sc.get(k), str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", sc[k]) is not None, f"schedule.{k} must be HH:MM")
    for k in ("new_matches", "tick_seconds", "max_cycle_hours"):
        _need(isinstance(sc.get(k), (int, float)) and sc[k] > 0, f"schedule.{k} must be positive")
    t = c.train
    for k in ("iters", "decisions", "workers", "threads", "league_versions", "seed_floor_every"):
        _need(isinstance(t.get(k), int) and t[k] >= 1, f"train.{k} must be a positive integer")
    _need(isinstance(t.get("critic_warmup"), int) and t["critic_warmup"] >= 0, "train.critic_warmup must be an integer")
    _need(t.get("twin") in ("auto", "off"), "train.twin must be auto or off")
    _need(isinstance(t.get("fixed_args"), list) and all(isinstance(a, str) for a in t["fixed_args"]), "train.fixed_args must be a list of strings")
    _need(isinstance(t.get("league_mix"), str), "train.league_mix must be a string")
    # With the statistics live the candidates train with the feints league of the network that
    # passed the explorer test (training/runs/m6-adaptive-r/args.json), so they keep that training.
    _need(isinstance(t.get("league_mix_live"), str) and mix_shares(t["league_mix_live"]).get("feints", 0) > 0, "train.league_mix_live must be a league mix with a feints share")
    for k in ("feint_hands", "feint_evidence"):
        _need(isinstance(t.get(k), str) and re.fullmatch(r"\d+,\d+", t[k]) is not None, f"train.{k} must be from,to")
    g = c.gate
    _need(g.get("stats") in ("empty", "live"), "gate.stats must be empty or live")
    for k in ("threads", "batch_pairs", "cap_pairs", "segment_pairs", "panel_pairs", "panel_versions", "personas_pairs"):
        _need(isinstance(g.get(k), int) and g[k] >= 1, f"gate.{k} must be a positive integer")
    _need(g["batch_pairs"] >= 4 and g["cap_pairs"] >= g["batch_pairs"], "gate.batch_pairs must be at least 4 and at most cap_pairs")
    _need(0 < g["p0"] < g["p1"] < 1 and 0 < g["alpha"] < 1 and 0 < g["beta"] < 1, "gate.p0 < p1 and alpha, beta in (0, 1)")
    a = c.ab
    _need(0 < a.get("share", -1) <= 0.5, "ab.share must be in (0, 0.5]")
    _need(isinstance(a.get("days"), int) and a["days"] >= 1, "ab.days must be a positive integer")
    _need(isinstance(a.get("bootstrap"), int) and a["bootstrap"] >= 100, "ab.bootstrap must be at least 100")
    for k in ("min_matches_per_arm", "min_people_per_arm"):
        _need(isinstance(a.get(k), int) and not isinstance(a.get(k), bool) and a[k] >= 1, f"ab.{k} must be a positive integer")
    # With people's data the rollback needs as many people per arm as the card needs before it shows
    # the comparison (contract 1.10), so the two cannot drift; a local test may ask for fewer.
    if c.mode == "r2" or c.profile == "prod":
        _need(a["min_people_per_arm"] == MIN_PEOPLE, f"ab.min_people_per_arm must be {MIN_PEOPLE} in r2 mode and profile prod: the people per arm the card needs before it shows the comparison (contract 1.10)")
    _need(0 < c.data.get("device_cap", 0) < 1, "data.device_cap must be in (0, 1)")
    for k, v in c.thresholds.items():
        _need(isinstance(v, int) and v >= 1, f"thresholds.{k} must be a positive integer")
    hm = c.human.get("model", {})
    if isinstance(hm, dict) and "league_share" in hm:
        # Moved from 'current' to 'human' in the candidate's league mix (zapcycle/train.py with_human).
        for key in ("league_mix", "league_mix_live"):
            cur = mix_shares(t[key]).get("current", 0)
            v = hm["league_share"]
            _need(isinstance(v, (int, float)) and 0 < v <= cur, f"human.model.league_share must be above 0 and at most the current share {cur} of train.{key}")
    x = c.explorer
    _need(isinstance(x.get("on"), bool), "explorer.on must be true or false")
    lim = x.get("limit")
    _need(isinstance(lim, (int, float)) and not isinstance(lim, bool) and 0 < lim <= EXPLORER_LIMIT_MAX, f"explorer.limit must be above 0 and at most {EXPLORER_LIMIT_MAX} (1 point)")
    _need(x.get("seeds") == "cycle", 'explorer.seeds must be "cycle"')
    _need(x.get("pool") in ("all", "grid", "fresh"), "explorer.pool must be all, grid or fresh")
    for k in EXPLORER_INTS:
        _need(isinstance(x.get(k), int) and not isinstance(x.get(k), bool) and x[k] >= 1, f"explorer.{k} must be a positive integer")
    for k in ("grid_limit", "trained_critic_warmup"):
        _need(isinstance(x.get(k), int) and not isinstance(x.get(k), bool) and x[k] >= 0, f"explorer.{k} must be an integer from 0")
    for k in ("trained_hours", "reserve_hours"):
        _need(isinstance(x.get(k), (int, float)) and not isinstance(x.get(k), bool) and x[k] > 0, f"explorer.{k} must be positive")
    _need(x["reserve_hours"] >= x["trained_hours"], "explorer.reserve_hours must be at least explorer.trained_hours")
    for k in ("twin", "twin2"):
        _need(isinstance(x.get(k), str) and x[k].endswith(".zapw"), f"explorer.{k} must be a model file")
    if c.profile == "prod":
        for p in explorer_size_problems(x):
            _need(False, p)
    fl = c.human.get("flags", {})
    if isinstance(fl, dict) and "lookback_days" in fl:
        # The Worker ignores a flag that comes less than CLEARED_GRACE_MS (worker/src/cycle-jobs.ts,
        # 15 days) after the owner cleared that person: a longer look back would raise evidence the
        # owner already judged again, right after the grace.
        _need(isinstance(fl["lookback_days"], int) and 1 <= fl["lookback_days"] < CLEARED_GRACE_DAYS, f"human.flags.lookback_days must be from 1 to {CLEARED_GRACE_DAYS - 1}")


def load_config(path: str | Path, env: dict | None = None) -> Config:
    env = os.environ if env is None else env
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    try:
        raw = tomllib.loads(p.read_text())
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise CycleError(f"config: cannot read {path}: {e}") from e
    for s in SECTIONS:
        _need(isinstance(raw.get(s), dict), f"missing table [{s}]")
    c = Config(path=p, raw=raw, profile=raw.get("profile", ""), **{s: dict(raw[s]) for s in SECTIONS})
    _check(c)
    if env.get("ZAP_CYCLE_TEST_THRESHOLDS") == "1" and c.mode == "minio":
        c = replace(c, thresholds={k: max(1, math.ceil(v / 25)) for k, v in c.thresholds.items()})
    return c
