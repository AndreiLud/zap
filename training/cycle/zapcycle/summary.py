"""summary.json in the public bucket (zap-summary/2 since milestone 7; contract 1.10 and
_local/m7/DATA-SPEC.md 2.2.3). A number built from human data appears only for a group of at least
20 distinct people (cells, scoreboard rows, people counts); the exception is humansVsZap.

P2 may extend the human layer fields in this file.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .core import Cycle, read_json, write_json
from .formats import PERSONA_STAT_KEYS, SEGMENTS
from .human import layers_off

MIN_PEOPLE = 20
ANCHORS = ("random", "base", "tuned", "v1")
SCHEMA = "zap-summary/2"
# Where a version keeps the duplicate pairs behind its characters' numbers once a summary found
# them in its cycle's work folder (work folders of older cycles are pruned).
PERSONA_PAIRS_FILE = "persona-pairs.json"


def iso_week(ms: int) -> str:
    y, w, _ = datetime.fromtimestamp(ms / 1000, timezone.utc).isocalendar()
    return f"{y}-W{w:02d}"


def read_records(path: Path | None) -> list[dict]:
    if path is None or not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def people_records(records: list[dict], mode: str) -> list[dict]:
    """Valid records of the profile's kind: production records in r2 mode, test records in minio mode."""
    return [r for r in records if r["test"] == (mode == "minio")]


def humans_vs_zap(records: list[dict]) -> dict:
    solo = [r for r in records if r["kind"] in ("solo1", "solo2") and r["humans"]]
    wins = sum(1 for r in solo if (r["humans"][0]["seat"] & 1) == r["winner"])
    since = min((r["endedAt"] for r in solo), default=None)
    return {"matches": len(solo), "humanWins": wins, "since": since}


def public_seats(r: dict) -> bool:
    """Whether a record may count in a public number built from people (cells, the A/B result): the
    same rule as open data. Every person seated is still linked (a person who deleted their data has
    no export row, so no group), is not flagged, has a weight above 0 and did not leave open data."""
    from .human.opendata import eligible

    return eligible(r, set())


def cells(records: list[dict], min_people: int = MIN_PEOPLE) -> list[dict]:
    """Per ISO week, variant and players: people (groups), matches and the people's win rate, over
    the records whose seats may count in public numbers (public_seats)."""
    acc: dict[tuple, dict] = {}
    for r in records:
        if r["kind"] not in ("solo1", "solo2") or not r["humans"] or not public_seats(r):
            continue
        variant, players = r["segment"].split("-")
        key = (iso_week(r["endedAt"]), variant, int(players))
        c = acc.setdefault(key, {"people": set(), "matches": 0, "wins": 0})
        c["matches"] += 1
        c["wins"] += 1 if (r["humans"][0]["seat"] & 1) == r["winner"] else 0
        g = r["humans"][0].get("group")
        if g:
            c["people"].add(g)
    out = []
    for (week, variant, players), c in sorted(acc.items()):
        if len(c["people"]) >= min_people:
            out.append({"week": week, "variant": variant, "players": players, "people": len(c["people"]), "matches": c["matches"], "humanWinRate": round(c["wins"] / c["matches"], 4)})
    return out


def scoreboard(records: list[dict], min_people: int = MIN_PEOPLE) -> list[dict]:
    """People against Zap by mode and versions: quick play (solo1 and solo2), the seats that may
    count in public numbers (public_seats, as cells), grouped by variant, players, the version facing
    the person and, in 2 against 2, the version of the person's AI partner (null in 1 against 1). A
    row only with at least min_people distinct people; humanWins counts the matches the person's
    team won."""
    acc: dict[tuple, dict] = {}
    for r in records:
        if r["kind"] not in ("solo1", "solo2") or not r["humans"] or not public_seats(r):
            continue
        variant, players = r["segment"].split("-")
        partner = r.get("partnerVersion") if r["kind"] == "solo2" else None
        key = (variant, int(players), r["aiVersion"], partner)
        c = acc.setdefault(key, {"people": set(), "matches": 0, "wins": 0})
        c["matches"] += 1
        c["wins"] += 1 if (r["humans"][0]["seat"] & 1) == r["winner"] else 0
        g = r["humans"][0].get("group")
        if g:
            c["people"].add(g)
    out = []
    for (variant, players, ai, partner), c in sorted(acc.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2], kv[0][3] or "")):
        if len(c["people"]) >= min_people:
            out.append({"variant": variant, "players": players, "aiVersion": ai, "partnerVersion": partner, "people": len(c["people"]), "matches": c["matches"], "humanWins": c["wins"]})
    return out


def persona_pairs(cyc: Cycle, v: str, card: dict) -> int | None:
    """The duplicate pairs behind each character's vsZap in the card, all segments pooled: the
    pairs per segment of the file the card's statistics came from (gate/personas-order.json when
    the cycle measured the order on fresh deals, else the calibration gate/personas.json; see
    card.personas_block) times the segments. Kept in the version's folder once found, since the work
    folders of older cycles are pruned. None when neither is known (the page then says nothing
    about a margin)."""
    kept = cyc.version_dir(v) / PERSONA_PAIRS_FILE
    if kept.exists():
        n = read_json(kept).get("pairs")
        return n if isinstance(n, int) and not isinstance(n, bool) and n >= 1 else None
    if not card.get("cycleId"):
        return None
    gate = cyc.cfg.work_dir / card["cycleId"] / "gate"
    src = next((gate / f for f in ("personas-order.json", "personas.json") if (gate / f).exists()), None)
    if src is None:
        return None
    per = read_json(src).get("pairsPerSegment")
    if not isinstance(per, int) or isinstance(per, bool) or per < 1:
        return None
    pairs = per * len(SEGMENTS)
    write_json(kept, {"pairs": pairs, "pairsPerSegment": per, "segments": len(SEGMENTS), "source": f"{card['cycleId']}/gate/{src.name}"})
    return pairs


def version_personas(cyc: Cycle, v: str, card: dict) -> dict | None:
    """card.personas.stats with the pairs behind them; None without both."""
    p = card.get("personas")
    if not p or not p.get("stats"):
        return None
    pairs = persona_pairs(cyc, v, card)
    if pairs is None:
        return None
    return {"pairs": pairs, "stats": {pid: {k: st[k] for k in PERSONA_STAT_KEYS} for pid, st in p["stats"].items()}}


def versions(cyc: Cycle, manifest: dict) -> list[dict]:
    """Every version that was served (bootstrap, promoted, rolled back), oldest first; the anchors
    come from the candidate side of the gate panel, null for the bootstrap. From the card too: the
    twin comparison (this version against the same training without people's games), the
    characters with the pairs behind them, and the data it trained on (people null under 20, as the
    card keeps it)."""
    out = []
    for v in manifest["models"]:
        card = cyc.card(v)
        if not card or card["result"] not in ("bootstrap", "promoted", "rolled-back"):
            continue
        anchors = None
        if card.get("gate"):
            panel = {p["member"]: p["candidate"] for p in card["gate"]["panel"]}
            if all(a in panel for a in ANCHORS):
                anchors = {a: {k: panel[a][k] for k in ("mean", "lo", "hi")} for a in ANCHORS}
        at = next((p["at"] for p in cyc.state.get("promotions", []) if p["version"] == v), manifest["models"][v]["createdAt"])
        twin = (card.get("twin") or {}).get("headToHead")
        data = card.get("data")
        out.append(
            {
                "version": v,
                "promotedAt": at,
                "result": card["result"],
                "anchors": anchors,
                "twin": {k: twin[k] for k in ("pairs", "mean", "lo", "hi")} if twin else None,
                "personas": version_personas(cyc, v, card),
                "data": {"validMatches": data["validMatches"], "people": data["people"] if (data["people"] or 0) >= MIN_PEOPLE else None} if data else None,
            }
        )
    return sorted(out, key=lambda x: (x["promotedAt"], int(x["version"][1:])))


def seed_noise(cyc: Cycle, manifest: dict) -> dict | None:
    """card.twin.seedNoise of the newest card that has it: the served versions' cards and every
    card this cycle keeps locally (a rejected candidate measured a floor too), newest resultAt
    first."""
    cards: dict[str, dict] = {}
    for v in manifest["models"]:
        c = cyc.card(v)
        if c:
            cards[v] = c
    if cyc.cards_dir.is_dir():
        for f in cyc.cards_dir.glob("*.json"):
            if f.stem not in cards:
                try:
                    cards[f.stem] = read_json(f)
                except (OSError, ValueError):
                    continue
    best = None
    for c in cards.values():
        noise = (c.get("twin") or {}).get("seedNoise")
        if noise and (best is None or (c.get("resultAt") or 0) > best[0]):
            best = (c.get("resultAt") or 0, noise)
    return {"floors": best[1]["floors"], "rms": best[1]["rms"]} if best else None


def ab_block(cyc: Cycle, manifest: dict, ab_result: dict | None) -> dict | None:
    st = cyc.state.get("ab")
    if not st:
        return None
    res = None
    detectable = None
    if ab_result and ab_result.get("bothArmsPeople") and ab_result.get("drop") is not None:
        res = {"drop": ab_result["drop"], "lo": ab_result["lo"], "hi": ab_result["hi"]}
        detectable = ab_result.get("detectablePoints")
    return {"version": st["version"], "control": st["control"], "share": manifest["controlShare"], "from": st["from"], "until": st["until"], "detectablePoints": detectable, "result": res}


def inputs_path(cyc: Cycle) -> Path:
    return cyc.cfg.data_dir / "summary-inputs.json"


def save_inputs(cyc: Cycle, records_path: Path | None, layers: dict | None, player_types: dict | None) -> None:
    """Keeps what a later summary needs (rollback and the daily A/B check have no tables of their own)."""
    prev = read_json(inputs_path(cyc)) if inputs_path(cyc).exists() else {}
    recs = people_records(read_records(records_path), cyc.cfg.mode) if records_path else None
    write_json(
        inputs_path(cyc),
        {
            "humansVsZap": humans_vs_zap(recs) if recs is not None else prev.get("humansVsZap"),
            "cells": cells(recs, MIN_PEOPLE) if recs is not None else prev.get("cells", []),
            "scoreboard": scoreboard(recs, MIN_PEOPLE) if recs is not None else prev.get("scoreboard", []),
            "layers": layers if layers is not None else prev.get("layers"),
            "playerTypes": player_types if layers is not None else prev.get("playerTypes"),
            "ab": prev.get("ab"),
        },
    )


def save_ab(cyc: Cycle, ab_result: dict | None) -> None:
    prev = read_json(inputs_path(cyc)) if inputs_path(cyc).exists() else {}
    prev["ab"] = ab_result
    write_json(inputs_path(cyc), prev)


def build_summary(cyc: Cycle, manifest: dict, status: dict | None) -> dict:
    inp = read_json(inputs_path(cyc)) if inputs_path(cyc).exists() else {}
    st = cyc.state.get("ab")
    return {
        "schema": SCHEMA,
        "generatedAt": cyc.clock(),
        "minPeople": MIN_PEOPLE,
        "training": {
            "state": (status or {}).get("state", "ok"),
            "finishedAt": (status or {}).get("finishedAt"),
            "current": manifest["current"],
            "nextAfter": st["until"] if st else None,
        },
        "humansVsZap": inp.get("humansVsZap") or {"matches": 0, "humanWins": 0, "since": None},
        "versions": versions(cyc, manifest),
        "ab": ab_block(cyc, manifest, inp.get("ab")),
        "layers": inp.get("layers") or layers_off(None),
        "cells": inp.get("cells") or [],
        "playerTypes": inp.get("playerTypes"),
        "seedNoise": seed_noise(cyc, manifest),
        "scoreboard": inp.get("scoreboard") or [],
        # Reserved for the human layer (DATA-SPEC open question 4): null until it measures them.
        "disagreements": None,
    }
