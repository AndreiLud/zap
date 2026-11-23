"""The human A/B window (contract 3.10), checked once a day.

Matches: valid production records with an arm, kind solo1 or solo2, ended inside the window, the
person's seat not abandoned, and the person's seat one that may count in public numbers (linked,
not flagged, weight above 0, not out of open data: summary.public_seats). Score 1 when the AI team
wins. drop = mean(control) - mean(candidate): a positive drop means people beat the new version more
often than the previous one. The interval comes from a cluster bootstrap (one cluster per person, by
the group of the latest export), with a seed from the version id.

The check runs every day of the 14-day window, so a single 95% bound would roll back a version that
is exactly `rollback_drop` worse far more often than 5% of the time (from 12.5% to 18.5% in the
review's simulation). The rollback therefore reads a constant boundary near z 2.33, the 1st
percentile of the bootstrap drops (`loSeq`); `lo` and `hi` (5th and 95th percentiles) are what the
card and the summary show. detectablePoints is the true drop the rule catches 80% of the time by
the end of a window with this spread: rollback_drop + (2.326 + 0.8416) sd.
"""

from __future__ import annotations

import hashlib
import math
import random
from pathlib import Path

from .core import Cycle, utc_date
from .summary import people_records, public_seats, read_records

Z_SEQ = 2.326  # the rollback boundary: 1st percentile of the bootstrap drops
Z_POWER = Z_SEQ + 0.8416  # with 80% power
SEQ_QUANTILE = 0.01


def ab_matches(records: list[dict], window: dict, mode: str) -> list[dict]:
    out = []
    for r in people_records(records, mode):
        if r.get("arm") not in ("candidate", "control") or r["kind"] not in ("solo1", "solo2") or not r["humans"] or not public_seats(r):
            continue
        if not window["from"] <= r["endedAt"] < window["until"]:
            continue
        h = r["humans"][0]
        if h["abandoned"]:
            continue
        ai_team = 1 - (h["seat"] & 1)
        out.append({"arm": r["arm"], "score": 1 if r["winner"] == ai_team else 0, "cluster": h["group"] or f"seat:{r['key']}:{h['seat']}", "group": h["group"]})
    return out


def seed_of(version: str) -> int:
    return int.from_bytes(hashlib.sha256(version.encode()).digest()[:8], "big")


def evaluate(matches: list[dict], version: str, resamples: int, rollback_drop: float = 0.02) -> dict:
    """Counts, people, drop, its cluster bootstrap interval (5th and 95th percentiles) and the
    rollback boundary loSeq (1st percentile)."""
    n = {"candidate": sum(1 for m in matches if m["arm"] == "candidate"), "control": sum(1 for m in matches if m["arm"] == "control")}
    groups = {"candidate": {m["group"] for m in matches if m["arm"] == "candidate" and m["group"]}, "control": {m["group"] for m in matches if m["arm"] == "control" and m["group"]}}
    people = len(groups["candidate"] | groups["control"])
    out = {"matches": n, "people": people if people >= 20 else None, "bothArmsPeople": min(len(groups["candidate"]), len(groups["control"])) >= 20, "drop": None, "lo": None, "hi": None, "loSeq": None, "detectablePoints": None, "sd": None}
    if not n["candidate"] or not n["control"]:
        return out
    mean = lambda arm: sum(m["score"] for m in matches if m["arm"] == arm) / n[arm]
    out["drop"] = mean("control") - mean("candidate")
    clusters: dict[str, list[tuple[str, int]]] = {}
    for m in matches:
        clusters.setdefault(m["cluster"], []).append((m["arm"], m["score"]))
    sums = [(sum(s for a, s in c if a == "candidate"), sum(1 for a, _ in c if a == "candidate"), sum(s for a, s in c if a == "control"), sum(1 for a, _ in c if a == "control")) for c in clusters.values()]
    rng = random.Random(seed_of(version))
    k = len(sums)
    drops = []
    for _ in range(resamples):
        cs = cn = ks = kn = 0
        for _ in range(k):
            a, b, c, d = sums[rng.randrange(k)]
            cs += a
            cn += b
            ks += c
            kn += d
        if cn and kn:
            drops.append(ks / kn - cs / cn)
    if len(drops) < 2:
        return out
    drops.sort()
    B = len(drops)
    mu = sum(drops) / B
    sd = math.sqrt(sum((x - mu) ** 2 for x in drops) / (B - 1))
    out.update(lo=drops[int(0.05 * B)], hi=drops[min(B - 1, int(0.95 * B))], loSeq=drops[int(SEQ_QUANTILE * B)], sd=sd, detectablePoints=round(100 * (rollback_drop + Z_POWER * sd), 1))
    return out


def decide(result: dict, cfg_ab: dict, now: int, until: int) -> str:
    """rollback, close or continue. The rollback reads the sequential boundary loSeq."""
    enough = min(result["matches"]["candidate"], result["matches"]["control"]) >= int(cfg_ab["min_matches_per_arm"])
    if enough and result.get("loSeq") is not None and result["loSeq"] > float(cfg_ab["rollback_drop"]):
        return "rollback"
    if now >= until:
        return "close"
    return "continue"


def card_ab(result: dict, window: dict, rolled_back: bool) -> dict:
    """The card's A/B block. The comparison's numbers (drop, lo, hi, detectablePoints) appear only
    once both arms have 20 people (contract 1.10); before that they stay in the private status
    message and the run's report only."""
    both = bool(result.get("bothArmsPeople"))
    r = lambda x: None if x is None or not both else round(x, 4)
    return {
        "from": window["from"],
        "until": window["until"],
        "matches": dict(result["matches"]),
        "people": result["people"],
        "drop": r(result["drop"]),
        "lo": r(result["lo"]),
        "hi": r(result["hi"]),
        "detectablePoints": result["detectablePoints"] if both else None,
        "rolledBack": rolled_back,
    }


def run_ab(cyc: Cycle, records_path: Path) -> dict:
    """The daily check: evaluate the open window, roll back or close it; always refresh the status."""
    from .publish import close_window, rollback, write_summary
    from .summary import save_ab

    now = cyc.clock()
    window = cyc.state.get("ab")
    manifest = cyc.require_manifest()
    out: dict = {"window": window, "action": "none"}
    if window and manifest.get("control") is None:
        cyc.state["ab"] = None
        cyc.state.save()
        window = None
    if window:
        res = evaluate(ab_matches(read_records(records_path), window, cyc.cfg.mode), window["version"], int(cyc.cfg.ab["bootstrap"]), float(cyc.cfg.ab["rollback_drop"]))
        save_ab(cyc, res)
        action = decide(res, cyc.cfg.ab, now, window["until"])
        out.update(result={k: v for k, v in res.items() if k not in ("sd", "loSeq")}, action=action)
        if action == "rollback":
            msg = f"{window['version']} rolled back to {window['control']} after the A/B test: people won {100 * res['drop']:.1f} points more against it (90% interval from {100 * res['lo']:.1f} to {100 * res['hi']:.1f})."
            rollback(cyc, window["control"], card_ab(res, window, True), msg)
        elif action == "close":
            close_window(cyc, card_ab(res, window, False))
        else:
            write_summary(cyc, manifest)
    else:
        # No window: the daily check still refreshes the public summary (people against Zap).
        write_summary(cyc, manifest)
    cyc.state["lastAbCheckDate"] = utc_date(now)
    cyc.state.save()
    cyc.touch_status()
    return out
