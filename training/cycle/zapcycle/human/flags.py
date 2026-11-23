"""Automation flags (contract 1.9 and 3.11). The cycle looks at each person of the latest export (a
group token, never a pseudonym) for four patterns, appends a `flag` operation to the profile's list
(data/<profile>/flags.json) and uploads that list as control/flags.json. The Worker's daily job
resolves the reference inside D1, so the cycle never learns who the person is. The owner reviews
the pending flags with `flags list`, then `flags confirm REF` (the flag stands) or `flags clear REF`
(it was a person), and `flags push` uploads the reviews.

Patterns, over the matches that started in the last `lookback_days` days:
* regular-times: the spread of the person's decision times (own decisions with more than one legal
  action, not automatic), (p90 - p10) / median, is below `regular_spread` over at least
  `regular_min_decisions` decisions. Times are measured on the server, so network jitter widens a
  fixed delay a little; the spread of people starts near 0.9, a fixed delay behind 90 ms of jitter
  reads about 0.25 and a delay drawn from 0.6 to 0.9 s about 0.32;
* around-the-clock: matches started in at least `clock_hours` distinct UTC hours within
  `clock_window_days` days (18 hours within one day: a person whose hours move during the week is
  not caught, a program that plays day and night is);
* volume: at least `volume_matches` matches within `volume_window_days` days;
* identical-sequences: at least `identical_matches` matches whose first `identical_prefix` own
  decisions (action and decision time band of `time_bin_ms`) are identical; a match counts only
  with at least `identical_min_decisions` own decisions.
Own decisions are the person's choices: automatic moves (the AI's) and forced moves are left out.
A program that waits a random time drawn over a wide range and plays human hours shows none of these
patterns; the flags do not claim to catch it.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from .. import formats
from ..context import CycleContext
from ..errors import CycleError
from ..storage import JSON_TYPE
from .common import dump, latest_export, layer, people, record_lines, decision_rows, section

FLAGS_KEY = "control/flags.json"
REASONS = ("regular-times", "around-the-clock", "volume", "identical-sequences")
DAY_MS = 86_400_000
HOUR_MS = 3_600_000
MAX_AGE_MS = formats.FLAG_OP_MAX_AGE_MS
MAX_OPS = formats.MAX_FLAG_OPS
DEFAULTS = {
    "lookback_days": 14,
    "regular_spread": 0.40,
    "regular_min_decisions": 200,
    "clock_hours": 18,
    "clock_window_days": 1,
    "volume_matches": 400,
    "volume_window_days": 7,
    "identical_matches": 3,
    "identical_prefix": 40,
    "identical_min_decisions": 20,
    "time_bin_ms": 500,
}


def settings(ctx: CycleContext) -> dict:
    return {**DEFAULTS, **section(ctx, "flags")}


@dataclass
class Finding:
    group: str
    reason: str
    evidence: str
    all_reasons: tuple[str, ...]


def _popcount(x: int) -> int:
    return bin(x).count("1")


def _max_in_window(times: list[int], window_ms: int) -> int:
    """The most matches that start within any window of window_ms."""
    t = sorted(times)
    best = 0
    j = 0
    for i in range(len(t)):
        while t[i] - t[j] >= window_ms:
            j += 1
        best = max(best, i - j + 1)
    return best


def _max_hours_in_window(times: list[int], window_ms: int) -> int:
    """The most distinct UTC hours of day among matches that start within any window of window_ms."""
    t = sorted(times)
    best = 0
    j = 0
    count: dict[int, int] = defaultdict(int)
    for i in range(len(t)):
        count[(t[i] // HOUR_MS) % 24] += 1
        while t[i] - t[j] >= window_ms:
            h = (t[j] // HOUR_MS) % 24
            count[h] -= 1
            if count[h] == 0:
                del count[h]
            j += 1
        best = max(best, len(count))
    return best


def time_spread(times: list[float]) -> tuple[float, float]:
    """(p90 - p10) / median of decision times, and the median."""
    t = sorted(times)
    n = len(t)
    median = t[n // 2]
    if median <= 0:
        return 0.0, median
    return (t[min(n - 1, int(0.9 * n))] - t[int(0.1 * n)]) / median, median


def detect(lines: list[dict], rows, now_ms: int, s: dict, skip: set[str] | None = None) -> tuple[list[Finding], int]:
    """Findings per group, first reason in REASONS order; and the number of groups examined."""
    skip = skip or set()
    cutoff = now_ms - int(s["lookback_days"]) * DAY_MS
    seat_group: dict[int, dict[int, str]] = {}
    starts: dict[str, list[int]] = defaultdict(list)
    for m, line in enumerate(lines):
        if not (cutoff <= line["startedAt"] <= now_ms):
            continue
        for h in line["humans"]:
            g = h.get("group")
            if g and g not in skip:
                seat_group.setdefault(m, {})[h["seat"]] = g
                starts[g].append(line["startedAt"])
    times: dict[str, list[float]] = defaultdict(list)
    seqs: dict[tuple[int, int], list[tuple[int, int, int]]] = defaultdict(list)
    bin_ms = int(s["time_bin_ms"])
    for d in rows:
        g = seat_group.get(d["m"], {}).get(d["seat"])
        if g is None or g != d.get("group"):
            continue
        # Only the person's own choices: an automatic move is the AI's, a forced one is no choice.
        if d.get("auto") or _popcount(int(d["legal"])) <= 1:
            continue
        ms = d.get("ms")
        if ms is not None:
            times[g].append(float(ms))
        seqs[(d["m"], d["seat"])].append((int(d["i"]), int(d["a"]), int(ms) // bin_ms if ms is not None else -1))
    prefixes: dict[str, dict[tuple, int]] = defaultdict(lambda: defaultdict(int))
    prefix = int(s["identical_prefix"])
    for (m, seat), seq in seqs.items():
        seq.sort()
        if len(seq) < int(s["identical_min_decisions"]):
            continue
        key = tuple((a, b) for _, a, b in seq[:prefix])
        prefixes[seat_group[m][seat]][key] += 1
    out: list[Finding] = []
    for g in sorted(starts):
        ev: dict[str, str] = {}
        t = times.get(g, [])
        if len(t) >= int(s["regular_min_decisions"]):
            spread, median = time_spread(t)
            if spread < float(s["regular_spread"]):
                ev["regular-times"] = f"time spread {spread:.3f} over {len(t)} decisions, median {median:.0f} ms"
        hours = _max_hours_in_window(starts[g], int(s["clock_window_days"]) * DAY_MS)
        if hours >= int(s["clock_hours"]):
            ev["around-the-clock"] = f"matches in {hours} distinct UTC hours within {int(s['clock_window_days'])} days"
        vol = _max_in_window(starts[g], int(s["volume_window_days"]) * DAY_MS)
        if vol >= int(s["volume_matches"]):
            ev["volume"] = f"{vol} matches within {int(s['volume_window_days'])} days"
        same = max(prefixes.get(g, {}).values(), default=0)
        if same >= int(s["identical_matches"]):
            ev["identical-sequences"] = f"{same} matches with the same first {prefix} decisions and time bands"
        if ev:
            reasons = tuple(r for r in REASONS if r in ev)
            text = "; ".join(ev[r] for r in reasons)
            out.append(Finding(g, reasons[0], clean_evidence(text), reasons))
    return out, len(starts)


def clean_evidence(text: str) -> str:
    """Printable ASCII of the allowed characters, at most 200 of them (contract 1.9)."""
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;=%()/+_-")
    return "".join(ch for ch in text if ch in allowed)[:200].rstrip()


# The list of operations -----------------------------------------------------------------------


def ops_path(ctx: CycleContext) -> Path:
    return ctx.data_dir / "flags.json"


def load_ops(ctx: CycleContext) -> dict:
    p = ops_path(ctx)
    if not p.exists():
        return {"schema": "zap-flags/1", "createdAt": ctx.now_ms, "ops": []}
    import json

    return formats.check("zap-flags/1", json.loads(p.read_text()))


def save_ops(ctx: CycleContext, doc: dict, now: int) -> dict:
    """Writes the list with createdAt = now; operations older than 400 days drop out, then the oldest
    ones beyond 5,000."""
    ops = [o for o in doc["ops"] if o["at"] >= now - MAX_AGE_MS and o["at"] <= now]
    ops = ops[-MAX_OPS:]
    out = formats.check("zap-flags/1", {"schema": "zap-flags/1", "createdAt": now, "ops": ops})
    dump(ops_path(ctx), out)
    return out


def reviews(doc: dict) -> dict[str, str]:
    """ref to its latest review ('confirm' or 'clear')."""
    out: dict[str, str] = {}
    for o in doc["ops"]:
        if o["op"] in ("confirm", "clear"):
            out[o["ref"]] = o["op"]
    return out


def pending(doc: dict) -> list[dict]:
    done = reviews(doc)
    return [o for o in doc["ops"] if o["op"] == "flag" and o["ref"] not in done]


def flagged_groups(ctx: CycleContext, export_date: str | None) -> set[str]:
    """Groups of this export with a flag of the cycle that was not cleared: they stay out of every
    human layer until the next export marks them."""
    if not export_date or not ops_path(ctx).exists():
        return set()
    doc = load_ops(ctx)
    cleared = {r for r, op in reviews(doc).items() if op == "clear"}
    return {o["ref"].split(":")[1] for o in doc["ops"] if o["op"] == "flag" and o["ref"].startswith(export_date + ":") and o["ref"] not in cleared}


def upload(ctx: CycleContext, doc: dict) -> dict:
    """control/flags.json in the models bucket, only when its bytes changed."""
    body = formats.dumps(formats.check("zap-flags/1", doc))
    sha = hashlib.sha256(body).hexdigest()
    prev = ctx.models.get(FLAGS_KEY, formats.SIZE_LIMITS["zap-flags/1"])
    if prev is not None and hashlib.sha256(prev.body).hexdigest() == sha:
        return {"key": FLAGS_KEY, "sha256": sha, "uploaded": False, "ops": len(doc["ops"])}
    ctx.models.put(FLAGS_KEY, body, JSON_TYPE)
    return {"key": FLAGS_KEY, "sha256": sha, "uploaded": True, "ops": len(doc["ops"])}


# The layer ------------------------------------------------------------------------------------


def run_flags(ctx: CycleContext) -> tuple[dict, set[str], dict]:
    """Detects, appends and uploads. Returns the layer, the groups flagged now (left out of this
    cycle's human layers) and a report for the work folder."""
    ex = latest_export(ctx)
    if ex is None:
        return layer(False, "Waits for the first complete daily export, which links seats to group tokens.", people=None), set(), {"export": None}
    s = settings(ctx)
    already = {r["group"] for r in ex["rows"] if r["flagged"]}
    doc = load_ops(ctx)
    refs = {o["ref"] for o in doc["ops"]}
    date = ex["date"]
    findings, examined = detect(record_lines(ctx), decision_rows(ctx), ctx.now_ms, s, skip=already)
    new = [f for f in findings if f"{date}:{f.group}" not in refs]
    if new:
        at = ctx.now_ms
        doc["ops"].extend({"ref": f"{date}:{f.group}", "op": "flag", "reason": f.reason, "evidence": f.evidence, "at": at} for f in new)
        doc = save_ops(ctx, doc, at)
    elif not ops_path(ctx).exists():
        doc = save_ops(ctx, doc, ctx.now_ms)
    up = upload(ctx, doc)
    report = {"export": date, "examined": examined, "new": [{"ref": f"{date}:{f.group}", "reasons": list(f.all_reasons)} for f in new], "pending": len(pending(doc)), "upload": up}
    why = "Checks each person of the latest export for decision times too regular, play around the clock, unusual volume and identical sequences; the owner reviews every flag."
    return layer(True, why, people=people(examined)), {f.group for f in findings} | flagged_groups(ctx, date), report


# The owner's review tool ----------------------------------------------------------------------


def receipt_status(ctx: CycleContext) -> dict[str, dict]:
    """ref to {status, date} from the newest local receipt that names it."""
    import json

    out: dict[str, dict] = {}
    d = ctx.data_dir / "receipts"
    for p in sorted(d.glob("*.json"), reverse=True) if d.is_dir() else []:
        try:
            jobs = json.loads(p.read_text())["jobs"]["flags"]
        except (OSError, ValueError, KeyError):
            continue
        for status in ("applied", "ignored", "unresolved", "reviewed"):
            for ref in jobs.get(status, []):
                out.setdefault(ref, {"status": status, "receipt": p.stem})
    return out


def iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def cmd_list(ctx: CycleContext) -> dict:
    doc = load_ops(ctx)
    rs = receipt_status(ctx)
    pend = [
        {"ref": o["ref"], "reason": o["reason"], "evidence": o["evidence"], "flaggedAt": iso(o["at"]), "receipt": rs.get(o["ref"], {"status": "not imported yet", "receipt": None})}
        for o in pending(doc)
    ]
    ex = latest_export(ctx)
    reports: dict[str, list[dict]] = defaultdict(list)
    for r in (ex or {}).get("reports", []):
        reports[r["group"] or "(no group: an AI seat or deleted data)"].append({"id": r["id"], "day": r["day"], "reason": r["reason"]})
    done = reviews(doc)
    return {
        "pending": pend,
        "reviewed": len(done),
        "reports": [{"group": g, "reports": v} for g, v in sorted(reports.items())],
        "export": (ex or {}).get("date"),
        "how": "flags confirm REF keeps a flag; flags clear REF lifts it; flags push uploads the reviews. Reports are reviewed as project_docs/moderation.md says.",
    }


def cmd_review(ctx: CycleContext, op: str, ref: str | None) -> dict:
    if op not in ("confirm", "clear"):
        raise CycleError(f"unknown review {op}")
    if not ref or not formats.REF.match(ref):
        raise CycleError("give the reference of a pending flag, as flags list shows it (YYYY-MM-DD:group)")
    doc = load_ops(ctx)
    if not any(o["op"] == "flag" and o["ref"] == ref for o in doc["ops"]):
        raise CycleError(f"no flag with the reference {ref}")
    if ref in reviews(doc):
        raise CycleError(f"{ref} was already reviewed ({reviews(doc)[ref]})")
    now = max(ctx.now_ms, doc["createdAt"])
    doc["ops"].append({"ref": ref, "op": op, "at": now})
    doc = save_ops(ctx, doc, now)
    return {"ref": ref, "op": op, "pending": len(pending(doc)), "next": "flags push uploads the list; the Worker applies it at its next daily run"}


def cmd_push(ctx: CycleContext) -> dict:
    if not ops_path(ctx).exists():
        raise CycleError("no flags yet: the list is made by the first cycle with an export")
    return upload(ctx, load_ops(ctx))
