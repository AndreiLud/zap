"""Model cards (zap-card/1, contract 1.4)."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime

from . import formats

MODEL_FIELDS = ("sha256", "bytes", "arch", "features", "inputs", "hidden", "adapt")
PERSONA_STATS = ("trucoRate", "bluffRate", "runRate", "reraiseRate", "signalTruth", "vsZap")


def model_fields(export_manifest: dict) -> dict:
    m = {k: export_manifest.get(k) for k in MODEL_FIELDS}
    m["adapt"] = m["adapt"] if m["features"] == "v2" else None
    return m


def manifest_entry(export_manifest: dict, created_at: int) -> dict:
    return {**model_fields(export_manifest), "personas": export_manifest.get("personas") or {}, "createdAt": created_at}


def knobs_sha256(knobs: dict) -> str:
    """SHA-256 of the calibrated knobs as compact JSON with sorted keys."""
    return hashlib.sha256(json.dumps(knobs, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def personas_block(calibration: dict, order: dict | None = None) -> dict:
    """The characters' knobs hash, the difficulty order and their statistics. With the order file of
    gate/personas-order.ts (fresh deals of the cycle), the order and the statistics come from it;
    the calibration's own order holds by construction."""
    stats = (order or calibration).get("stats", {})
    o = (order or calibration).get("order", {})
    return {
        "knobsSha256": knobs_sha256(calibration.get("knobs", {})),
        "orderHolds": bool(o.get("otavioEasiest")) and bool(o.get("iaraHardestAfterZap")),
        # A character whose sample had no chance for one statistic (null) is left out.
        "stats": {pid: {k: s[k] for k in PERSONA_STATS} for pid, s in stats.items() if all(isinstance(s.get(k), (int, float)) and not isinstance(s.get(k), bool) for k in PERSONA_STATS)},
    }


def iso_ms(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def bootstrap_card(bundled: dict, now: int) -> dict:
    card = {
        "schema": "zap-card/1",
        "version": bundled["version"],
        "parent": None,
        "cycleId": None,
        "createdAt": iso_ms(bundled["createdAt"]),
        "result": "bootstrap",
        "resultAt": now,
        "reason": f"bundled bootstrap model ({bundled.get('source', 'unknown source')})"[:500],
        "model": {**{k: bundled.get(k) for k in MODEL_FIELDS if k != "adapt"}, "adapt": bundled.get("adapt")},
        "training": None,
        "data": None,
        "gate": None,
        "personas": None,
        "twin": None,
        "ab": None,
    }
    return formats.check("zap-card/1", card)


def _num(x) -> str:
    """A rule's number as people write it: 0.5, 0.515, 2500."""
    return f"{x:g}" if isinstance(x, float) else str(x)


def _member(m: dict) -> str:
    """A panel member and how it plays: random, a heuristic and its parameters, or a model file and its knobs."""
    a = m.get("agent") or {}
    if a.get("kind") == "heuristic":
        return f"{m['member']} (heuristic {a.get('params')})"
    if a.get("kind") == "net":
        return f"{m['member']} ({str(a.get('model', '')).rsplit('/', 1)[-1]}, knobs {a.get('knobs')})"
    return m["member"]


def gate_rules(spec: dict | None, mode: str | None = None) -> str:
    """The rules the gate applied, from its spec (gate/spec.json), for the card's reason: zap-card/1
    has no field for them, so the reason carries them. Empty without a spec."""
    if not spec:
        return ""
    sp, sg, pt = spec["sprt"], spec["segments"], spec["panelTest"]
    members = ", ".join(_member(m) for m in spec.get("panel", []))
    where = "local copy of the cycle (minio)" if mode == "minio" else (f"cycle {mode}" if mode else "")
    parts = [
        f"SPRT {_num(sp['p0'])} against {_num(sp['p1'])}, alpha {_num(sp['alpha'])}, beta {_num(sp['beta'])}, rounds of {sp['batchPairs']} pairs up to {sp['capPairs']}",
        f"segments: non-inferiority {_num(round(100 * sg['margin'], 3))} points on {sg['pairs']} pairs each",
        f"panel {members}: {_num(round(100 * pt['margin'], 3))} point on {pt['pairs']} pairs per segment",
        f"statistics {spec.get('stats')}",
        f"{spec.get('threads')} threads" + (f", {where}" if where else ""),
    ]
    return "; ".join(parts)


def _pts(x: float) -> str:
    """Points with two decimals, half away from zero."""
    v = int(abs(x) * 10000 + 0.5 + 1e-9) / 100
    return f"{'-' if x < 0 and v != 0 else ''}{v:.2f}"


def explorer_sentence(explorer: dict) -> str:
    """The explorer test in one sentence, for the reason of a card that has explorer."""
    if not explorer["pass"]:
        why = " ".join(explorer["reasons"])
        return why if why.startswith("Refused by the explorer guard") else "Not promoted by the explorer test: " + why
    vs = explorer["verdicts"]
    worst = max(v["upper95"] for v in vs)
    reused = explorer.get("reusedFrom")
    how = f", reusing the verdict of {reused['source']} for the same network" if reused else ""
    lift = explorer.get("lifted")
    lifted = f" The owner lifted the earlier failure of this network ({', '.join(lift['failedIn'])}): {lift['reason']}" if lift else ""
    return f"Passed the explorer test: {len(vs)} verdicts{how}, the largest one-sided 95% upper bound of the adaptation part {_pts(worst)} points, limit {_pts(explorer['limit'])}.{lifted}"


def candidate_card(train: dict, gate: dict, data: dict | None, calibration: dict | None, twin: dict | None, cycle_id: str, now: int, created_at: int, force: str | None = None, order: dict | None = None, spec: dict | None = None, mode: str | None = None, explorer: dict | None = None) -> dict:
    """force: the override of a local test (minio mode); the measured gate result stays in the card.
    spec: the gate's spec.json, whose rules go into the reason (zap-card/1 has no field for them).
    explorer: the explorer block of a file that can read (zapcycle/explorer.py card_block); such a
    card is promoted only when the gate and the explorer test both pass."""
    exp = train["export"]["manifest"]
    gate_passed = bool(gate["pass"]) if force is None else force == "pass"
    passed = gate_passed and (explorer is None or explorer["pass"] is True)
    rules = gate_rules(spec, mode)
    if passed:
        reason = f"Passed every rule of the gate ({rules})." if rules else "Passed every rule of the gate."
        if explorer is not None:
            reason = explorer_sentence(explorer) + " " + reason
    elif gate_passed:
        reason = "Passed the gate. " + explorer_sentence(explorer)
    else:
        reason = " ".join(gate["reasons"]) or "Failed the gate."
    if force is not None:
        reason = f"Forced to {force} in a local test. Measured: " + ("passed every rule." if gate["pass"] else " ".join(gate["reasons"]))
        if explorer is not None and gate_passed:
            reason = explorer_sentence(explorer) + " " + reason
    card = {
        "schema": "zap-card/1",
        "version": train["version"],
        "parent": train["parent"],
        "cycleId": cycle_id,
        "createdAt": created_at,
        "result": "promoted" if passed else "rejected",
        "resultAt": now,
        "reason": reason[:500],
        "model": model_fields(exp),
        "training": train["training"],
        "data": data,
        "gate": gate,
        "personas": personas_block(calibration, order) if calibration else None,
        "twin": twin,
        "ab": None,
    }
    if explorer is not None:
        card["explorer"] = explorer
    return formats.check("zap-card/1", card)
