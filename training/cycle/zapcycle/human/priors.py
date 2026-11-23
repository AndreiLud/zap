"""Population priors (contract 1.8, 1.12, 3.11): node/human/profiles.ts sums each person's style
counters (shared/profile.ts) over the cycle's records and fits the priors with fitPriors, the
bundled self-play priors as fallback. Every cycle uploads control/priors.json; the Worker imports
it for "How Zap reads you". A number comes from people only when at least `priors_people` people
have 10 observations of it (never fewer than 20); otherwise it keeps the self-play value."""

from __future__ import annotations

import json

from .. import formats
from ..config import ROOT
from ..context import CycleContext
from ..storage import JSON_TYPE
from .common import DEFAULT_PRIORS, MIN_PEOPLE, layer, node, people, records_dir, work, write_groups

PRIORS_KEY = "control/priors.json"


def run_profiles(ctx: CycleContext, exclude: set[str]) -> dict:
    """Runs profiles.ts into work/human/profiles/ and returns its summary."""
    out = work(ctx) / "profiles"
    ex = write_groups(work(ctx) / "exclude-groups.txt", exclude)
    r = node(
        ctx, "profiles.ts",
        "--records", str(records_dir(ctx)), "--tables", str(ctx.tables_dir), "--out", str(out),
        "--fallback", str(ROOT / DEFAULT_PRIORS), "--min-people", str(int(ctx.config.thresholds["priors_people"])),
        "--now", str(ctx.now_ms), "--exclude-groups", str(ex),
    )
    r["dir"] = str(out)
    return r


def load_priors(ctx: CycleContext) -> dict:
    p = work(ctx) / "profiles" / "priors.json"
    return formats.check("zap-priors/1", json.loads(p.read_text()))


def readings(ctx: CycleContext) -> list[dict]:
    p = work(ctx) / "profiles" / "readings.jsonl"
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()] if p.exists() else []


def run_priors(ctx: CycleContext, prof: dict) -> tuple[dict, dict]:
    pri = load_priors(ctx)
    ctx.models.put(PRIORS_KEY, formats.dumps(pri), JSON_TYPE)
    # fitPriors never takes a number from fewer than 20 people, whatever the thresholds say.
    need = max(MIN_PEOPLE, int(ctx.config.thresholds["priors_people"]))
    report = {"source": pri["source"], "people": pri["people"], "groups": prof.get("groups"), "uploaded": PRIORS_KEY}
    if pri["source"] == "people":
        why = f"The population priors come from people: each number with at least {need} people with enough observations, the others from self-play."
        return layer(True, why, people=people(pri["people"]), peopleNeeded=need), report
    why = f"Uses the self-play priors until {need} people have at least 10 observations of a number."
    return layer(False, why, people=people(prof.get("groups")), peopleNeeded=need), report
