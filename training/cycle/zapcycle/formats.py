"""Checks of every JSON format the cycle reads or writes (contract section 1), mirroring
shared/cycle-formats.ts rule for rule: exact keys (an unknown or missing key is an error), null only where the
format allows it, size limits checked before parsing.

validate(schema, obj) returns a list of errors (empty when valid); check(schema, obj) raises
FormatError; load(schema, data) checks the size, parses and checks.
"""

from __future__ import annotations

import json
import math
import re
from datetime import date
from typing import Any, Callable

from .errors import FormatError

VERSION = re.compile(r"^v[1-9][0-9]{0,5}$")
AI_LABEL = re.compile(r"^[A-Za-z0-9._:-]{1,40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
GROUP = re.compile(r"^[0-9a-f]{16}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
WEEK = re.compile(r"^\d{4}-W\d{2}$")
CYCLE_ID = re.compile(r"^\d{8}-\d{4}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
REF = re.compile(r"^\d{4}-\d{2}-\d{2}:[0-9a-f]{16}$")
EVIDENCE = re.compile(r"^[A-Za-z0-9 .,:;=%()/+_-]{0,200}$")
SEED_BASE = re.compile(r"^[0-9a-f]{1,16}$")
COMMIT = re.compile(r"^[0-9a-f]{7,64}$")
EXPORT_KEY = re.compile(r"^exports/\d{4}-\d{2}-\d{2}\.json$")
CONTROL = re.compile(r"[\u0000-\u001f\u007f]")

SEGMENTS = ("paulista-2", "paulista-4", "mineiro-2", "mineiro-4")
PERSONA_IDS = ("otavio", "bento", "lia", "ravi", "iara", "zap")
READING_KEYS = ("raise", "run", "accept", "reraise", "shown", "cover", "bluff", "signalTruth")
PRIOR_KEYS = ("raise", "run", "accept", "reraise", "shown", "cover")
READING_SEGMENT_KEYS = ("bluff",)  # reading numbers with per segment values in readingSegments
# Object.keys(NEUTRAL_KNOBS) of ai/src/net-agent.ts and Object.keys(BASE_PARAMS) of ai/src/heuristic.ts
# (tests/test_formats.py compares them with the TypeScript sources).
KNOB_KEYS = ("temperature", "raise", "accept", "run", "cover", "bluff", "signalLie", "style", "styleShare", "switchStyles", "persona")
KNOB_NUMBERS = ("temperature", "raise", "accept", "run", "cover", "bluff", "signalLie", "styleShare")
# KNOB_RANGES of shared/cycle-formats.ts: a manifest's persona knobs stay inside these.
KNOB_RANGES = {"temperature": (0.05, 10), "raise": (-20, 20), "accept": (-20, 20), "run": (-20, 20), "cover": (-20, 20), "bluff": (-20, 20), "signalLie": (0, 1), "styleShare": (0, 1), "persona": (-10, 10)}
PERSONA_DIMS = 8  # ai/src/features.ts
STYLE_KEYS = ("w", "raise", "accept", "reraise", "onze", "bluff", "bluffBelow", "lead1", "leadLater", "signalTruth", "behind")
LAYER_KEYS = ("humanModel", "priors", "adaptation", "playerTypes", "ranking", "openData", "flags")
CARD_RESULTS = ("bootstrap", "promoted", "rejected", "rolled-back")
STEPS = ("sync", "build", "human", "train", "gate", "publish", "ab", "idle")
REPORT_REASONS = ("nickname", "phrases", "cheating", "other")
FLAG_REASONS = ("regular-times", "around-the-clock", "volume", "identical-sequences")
ANCHORS = ("random", "base", "tuned", "v1")
PERSONA_STAT_KEYS = ("trucoRate", "bluffRate", "runRate", "reraiseRate", "signalTruth", "vsZap")
DISAGREEMENT_TYPES = ("answer", "onze", "bet", "card")
MIN_PEOPLE = 20  # a number built from people's games comes from at least this many (contract 1.10)
MAX_SCOREBOARD_ROWS = 10_000
SUMMARY_KEYS_V1 = ("schema", "generatedAt", "minPeople", "training", "humansVsZap", "versions", "ab", "layers", "cells", "playerTypes")
SUMMARY_KEYS_V2 = SUMMARY_KEYS_V1 + ("seedNoise", "scoreboard", "disagreements")
SUMMARY_VERSION_KEYS_V1 = ("version", "promotedAt", "result", "anchors")
SUMMARY_VERSION_KEYS_V2 = SUMMARY_VERSION_KEYS_V1 + ("twin", "personas", "data")
MAX_MODEL_BYTES = 2_097_152
MAX_MODELS = 500
MAX_FLAG_OPS = 5000
FLAG_OP_MAX_AGE_MS = 400 * 86_400_000
MS_MAX = 8.64e15
SAFE_MAX = 2**53 - 1

SIZE_LIMITS = {
    "zap-match": 256 * 1024,
    "zap-manifest/1": 256 * 1024,
    "zap-card/1": 1024 * 1024,
    "zap-gate/1": 1024 * 1024,
    "zap-status/1": 16 * 1024,
    "zap-export/1": 100 * 1024 * 1024,
    "zap-receipt/1": 1024 * 1024,
    "zap-priors/1": 64 * 1024,
    "zap-flags/1": 512 * 1024,
    "zap-summary/1": 1024 * 1024,
    "zap-summary/2": 1024 * 1024,
}


def is_int(x: Any) -> bool:
    return type(x) is int or (type(x) is float and x.is_integer() and abs(x) <= SAFE_MAX)


def is_num(x: Any) -> bool:
    return type(x) in (int, float) and math.isfinite(x)


def is_ms(x: Any) -> bool:
    return is_int(x) and 0 <= x <= MS_MAX


def is_date(x: Any) -> bool:
    if not isinstance(x, str) or not DATE.match(x):
        return False
    try:
        date.fromisoformat(x)
        return True
    except ValueError:
        return False


class C:
    """Collects errors while walking one object (the Check class of shared/cycle-formats.ts)."""

    def __init__(self) -> None:
        self.errors: list[str] = []

    def fail(self, where: str, msg: str) -> bool:
        self.errors.append(f"{where}: {msg}")
        return False

    def obj(self, o: Any, keys, where: str) -> bool:
        if not isinstance(o, dict):
            return self.fail(where, "not an object")
        ok = True
        for k in o:
            if k not in keys:
                ok = self.fail(where, f"unexpected field {k}")
        for k in keys:
            if k not in o:
                ok = self.fail(where, f"missing field {k}")
        return ok

    def map(self, o: Any, where: str) -> bool:
        return isinstance(o, dict) or self.fail(where, "not an object")

    def arr(self, x: Any, where: str, max_len: float = math.inf) -> bool:
        if not isinstance(x, list):
            return self.fail(where, "not an array")
        if len(x) > max_len:
            return self.fail(where, f"more than {max_len} entries")
        return True

    def lit(self, x: Any, where: str, value: Any) -> bool:
        return (x == value and type(x) is type(value)) or self.fail(where, f"must be {json.dumps(value)}")

    def one_of(self, x: Any, where: str, values) -> bool:
        return any(x == v and type(x) is type(v) for v in values) or self.fail(where, f"must be one of {', '.join(str(v) for v in values)}")

    def bool_(self, x: Any, where: str) -> bool:
        return type(x) is bool or self.fail(where, "not a boolean")

    def num(self, x: Any, where: str, lo: float = -math.inf, hi: float = math.inf) -> bool:
        if not is_num(x):
            return self.fail(where, "not a finite number")
        if x < lo or x > hi:
            return self.fail(where, f"out of range {lo} to {hi}")
        return True

    def int_(self, x: Any, where: str, lo: float = 0, hi: float = SAFE_MAX) -> bool:
        if not is_int(x):
            return self.fail(where, "not an integer")
        if x < lo or x > hi:
            return self.fail(where, f"out of range {lo} to {hi}")
        return True

    def ms(self, x: Any, where: str) -> bool:
        return self.int_(x, where, 0, MS_MAX)

    def str_(self, x: Any, where: str, pattern: re.Pattern | None = None, max_chars: float = math.inf) -> bool:
        if not isinstance(x, str):
            return self.fail(where, "not a string")
        if len(x) > max_chars:
            return self.fail(where, f"longer than {max_chars} characters")
        if pattern is not None and not pattern.match(x):
            return self.fail(where, f"does not match {pattern.pattern}")
        return True

    def date_(self, x: Any, where: str) -> bool:
        if not self.str_(x, where, DATE):
            return False
        return is_date(x) or self.fail(where, "not a calendar date")

    def text(self, x: Any, where: str, max_chars: int) -> bool:
        if not self.str_(x, where, None, max_chars):
            return False
        return not CONTROL.search(x) or self.fail(where, "control characters")


def _all_finite(c: C, x: Any, where: str) -> None:
    if type(x) in (int, float):
        c.num(x, where)
    elif isinstance(x, list):
        for i, v in enumerate(x):
            _all_finite(c, v, f"{where}[{i}]")
    elif isinstance(x, dict):
        for k, v in x.items():
            _all_finite(c, v, f"{where}.{k}")


def _style(c: C, x: Any, where: str) -> None:
    if not c.obj(x, STYLE_KEYS, where):
        return
    for k in STYLE_KEYS:
        v = x[k]
        if isinstance(v, list):
            for i, n in enumerate(v):
                c.num(n, f"{where}.{k}[{i}]")
        else:
            c.num(v, f"{where}.{k}")


def _personas(c: C, x: Any, where: str) -> None:
    if not c.map(x, where):
        return
    for pid, k in x.items():
        p = f"{where}.{pid}"
        if pid not in PERSONA_IDS:
            c.fail(where, f"unknown persona {pid}")
            continue
        if not c.obj(k, KNOB_KEYS, p):
            continue
        for key in KNOB_NUMBERS:
            c.num(k[key], f"{p}.{key}", *KNOB_RANGES[key])
        if k["style"] is not None:
            _style(c, k["style"], f"{p}.style")
        if k["switchStyles"] is not None and c.arr(k["switchStyles"], f"{p}.switchStyles"):
            for i, st in enumerate(k["switchStyles"]):
                _style(c, st, f"{p}.switchStyles[{i}]")
        if c.arr(k["persona"], f"{p}.persona", PERSONA_DIMS):
            for i, n in enumerate(k["persona"]):
                c.num(n, f"{p}.persona[{i}]", *KNOB_RANGES["persona"])
        _all_finite(c, k, p)


MODEL_INFO_KEYS = ("sha256", "bytes", "arch", "features", "inputs", "hidden", "adapt")


def _adapt(c: C, x: Any, where: str) -> None:
    if x is None or not c.obj(x, ("bmax", "nHalf"), where):
        return
    if c.num(x["bmax"], f"{where}.bmax") and x["bmax"] <= 0:
        c.fail(f"{where}.bmax", "must be positive")
    if c.num(x["nHalf"], f"{where}.nHalf") and x["nHalf"] <= 0:
        c.fail(f"{where}.nHalf", "must be positive")


def _model_info(c: C, x: dict, where: str) -> None:
    c.str_(x["sha256"], f"{where}.sha256", HEX64)
    c.int_(x["bytes"], f"{where}.bytes", 1, MAX_MODEL_BYTES)
    c.lit(x["arch"], f"{where}.arch", "mlp-v1")
    c.one_of(x["features"], f"{where}.features", ("v1", "v2", "v2-empty"))
    c.int_(x["inputs"], f"{where}.inputs", 1, 1_000_000)
    if c.arr(x["hidden"], f"{where}.hidden", 16):
        if not x["hidden"]:
            c.fail(f"{where}.hidden", "empty")
        for i, h in enumerate(x["hidden"]):
            c.int_(h, f"{where}.hidden[{i}]", 1, 1_000_000)
    _adapt(c, x["adapt"], f"{where}.adapt")
    if x["features"] == "v2" and x["adapt"] is None:
        c.fail(f"{where}.adapt", "required for features v2")
    if x["features"] != "v2" and x["adapt"] is not None:
        c.fail(f"{where}.adapt", "only for features v2")


def v_manifest(m: Any) -> list[str]:
    c = C()
    if not c.obj(m, ("schema", "current", "control", "controlShare", "controlUntil", "updatedAt", "models"), "manifest"):
        return c.errors
    c.lit(m["schema"], "schema", "zap-manifest/1")
    c.str_(m["current"], "current", VERSION)
    if m["control"] is not None:
        c.str_(m["control"], "control", VERSION)
    c.num(m["controlShare"], "controlShare", 0, 0.5)
    if m["controlUntil"] is not None:
        c.ms(m["controlUntil"], "controlUntil")
    if (m["control"] is None) != (m["controlUntil"] is None):
        c.fail("controlUntil", "null exactly when control is null")
    c.ms(m["updatedAt"], "updatedAt")
    if c.map(m["models"], "models"):
        ids = list(m["models"])
        if not 1 <= len(ids) <= MAX_MODELS:
            c.fail("models", f"from 1 to {MAX_MODELS} entries")
        for v in ids:
            p = f"models.{v}"
            if not VERSION.match(v):
                c.fail("models", f"bad version id {v}")
            e = m["models"][v]
            if not c.obj(e, MODEL_INFO_KEYS + ("personas", "createdAt"), p):
                continue
            _model_info(c, e, p)
            _personas(c, e["personas"], f"{p}.personas")
            c.ms(e["createdAt"], f"{p}.createdAt")
        if isinstance(m["current"], str) and m["current"] not in m["models"]:
            c.fail("current", "not a key of models")
        if isinstance(m["control"], str) and m["control"] not in m["models"]:
            c.fail("control", "not a key of models")
    if m["control"] is not None and m["control"] == m["current"]:
        c.fail("control", "equals current")
    return c.errors


def _interval(c: C, x: Any, where: str, pairs: bool = False) -> None:
    if not c.obj(x, ("pairs", "mean", "lo", "hi") if pairs else ("mean", "lo", "hi"), where):
        return
    if pairs:
        c.int_(x["pairs"], f"{where}.pairs")
    for k in ("mean", "lo", "hi"):
        c.num(x[k], f"{where}.{k}")
    if is_num(x["lo"]) and is_num(x["hi"]) and x["lo"] > x["hi"]:
        c.fail(where, "lo above hi")


def _segments_map(c: C, x: Any, where: str, each) -> None:
    if not c.obj(x, SEGMENTS, where):
        return
    for s in SEGMENTS:
        each(x[s], f"{where}.{s}")


def _gate(c: C, g: Any, where: str) -> None:
    if not c.obj(g, ("schema", "candidate", "current", "seed", "stats", "sprt", "segments", "panel", "personas", "pass", "reasons", "seconds"), where):
        return
    c.lit(g["schema"], f"{where}.schema", "zap-gate/1")
    for side in ("candidate", "current"):
        v = g[side]
        if c.obj(v, ("version", "sha256"), f"{where}.{side}"):
            c.str_(v["version"], f"{where}.{side}.version", VERSION)
            c.str_(v["sha256"], f"{where}.{side}.sha256", HEX64)
    c.str_(g["seed"], f"{where}.seed", HEX64)
    c.one_of(g["stats"], f"{where}.stats", ("empty", "live"))
    accept = False
    s = g["sprt"]
    if c.obj(s, ("decision", "llr", "lower", "upper", "pairs", "mean", "perSegment"), f"{where}.sprt"):
        c.one_of(s["decision"], f"{where}.sprt.decision", ("accept", "reject", "inconclusive"))
        accept = s["decision"] == "accept"
        for k in ("llr", "lower", "upper", "mean"):
            c.num(s[k], f"{where}.sprt.{k}")
        c.int_(s["pairs"], f"{where}.sprt.pairs")

        def per(v, p):
            if c.obj(v, ("pairs", "mean"), p):
                c.int_(v["pairs"], f"{p}.pairs")
                c.num(v["mean"], f"{p}.mean")

        _segments_map(c, s["perSegment"], f"{where}.sprt.perSegment", per)
    all_pass = [True]

    def seg(v, p):
        if not c.obj(v, ("pairs", "mean", "lo95", "pass"), p):
            return
        c.int_(v["pairs"], f"{p}.pairs")
        c.num(v["mean"], f"{p}.mean")
        c.num(v["lo95"], f"{p}.lo95")
        c.bool_(v["pass"], f"{p}.pass")
        if v["pass"] is not True:
            all_pass[0] = False

    _segments_map(c, g["segments"], f"{where}.segments", seg)
    if c.arr(g["panel"], f"{where}.panel", 64):
        members: set[str] = set()
        for i, e in enumerate(g["panel"]):
            p = f"{where}.panel[{i}]"
            if not c.obj(e, ("member", "pairs", "candidate", "current", "diff", "pass"), p):
                continue
            if c.str_(e["member"], f"{p}.member", AI_LABEL):
                if e["member"] in members:
                    c.fail(f"{p}.member", "listed twice")
                members.add(e["member"])
            c.int_(e["pairs"], f"{p}.pairs")
            _interval(c, e["candidate"], f"{p}.candidate")
            _interval(c, e["current"], f"{p}.current")
            if c.obj(e["diff"], ("mean", "lo95"), f"{p}.diff"):
                c.num(e["diff"]["mean"], f"{p}.diff.mean")
                c.num(e["diff"]["lo95"], f"{p}.diff.lo95")
            c.bool_(e["pass"], f"{p}.pass")
            if e["pass"] is not True:
                all_pass[0] = False
    order = False
    if c.obj(g["personas"], ("orderHolds", "source"), f"{where}.personas"):
        c.bool_(g["personas"]["orderHolds"], f"{where}.personas.orderHolds")
        c.str_(g["personas"]["source"], f"{where}.personas.source", None, 500)
        order = g["personas"]["orderHolds"] is True
    if c.bool_(g["pass"], f"{where}.pass") and not c.errors and g["pass"] != (accept and all_pass[0] and order):
        c.fail(f"{where}.pass", "must be SPRT accept, every segment and panel entry passing, and the persona order holding")
    if c.arr(g["reasons"], f"{where}.reasons", 64):
        for i, r in enumerate(g["reasons"]):
            c.text(r, f"{where}.reasons[{i}]", 500)
        if g["pass"] is True and g["reasons"]:
            c.fail(f"{where}.reasons", "a passing gate has no reasons")
        if g["pass"] is False and not g["reasons"]:
            c.fail(f"{where}.reasons", "a failing gate names its reasons")
    c.num(g["seconds"], f"{where}.seconds", 0)


def v_gate(x: Any) -> list[str]:
    c = C()
    _gate(c, x, "gate")
    return c.errors


def _ab(c: C, x: Any, where: str) -> None:
    if not c.obj(x, ("from", "until", "matches", "people", "drop", "lo", "hi", "detectablePoints", "rolledBack"), where):
        return
    c.ms(x["from"], f"{where}.from")
    c.ms(x["until"], f"{where}.until")
    if is_num(x["from"]) and is_num(x["until"]) and x["until"] < x["from"]:
        c.fail(f"{where}.until", "before from")
    if c.obj(x["matches"], ("candidate", "control"), f"{where}.matches"):
        c.int_(x["matches"]["candidate"], f"{where}.matches.candidate")
        c.int_(x["matches"]["control"], f"{where}.matches.control")
    if x["people"] is not None:
        c.int_(x["people"], f"{where}.people", 20)
    for k in ("drop", "lo", "hi", "detectablePoints"):
        if x[k] is None:
            continue
        # The comparison's numbers appear only once both arms have 20 people (contract 1.10).
        if x["people"] is None:
            c.fail(f"{where}.{k}", "null while people is null")
        else:
            c.num(x[k], f"{where}.{k}")
    c.bool_(x["rolledBack"], f"{where}.rolledBack")


EXPLORER_KINDS = ("scripted", "trained", "control")
EXPLORER_SOURCES = ("measured", "reused", "none")
EXPLORER_KEYS = ("network", "sha256", "pass", "limit", "source", "reusedFrom", "verdicts", "failuresOnRecord", "pending", "reasons")
EXPLORER_VERDICT_KEYS = ("explorer", "kind", "sha256", "mean", "upper95", "pairs", "pass")
# Added in milestone 10, so optional (cards written before have none): the explorers on record that
# never failed, the [explorer] sizes the step ran with, the PPO explorer's iterations, the owner's lift.
EXPLORER_OPTIONAL = ("measuredOnRecord", "settings", "ppo", "lifted")
EXPLORER_LIMIT_MAX = 0.01  # the owner's 1 point (training/cycle/zapcycle/explorer.py LIMIT_MAX)


def _card_explorer(c: C, x: Any, where: str, result: Any) -> None:
    """card.explorer: the explorer test of a candidate that can read the in-match statistics
    (training/cycle/zapcycle/explorer.py). Optional: cards of files that cannot read have none."""
    keys = EXPLORER_KEYS + tuple(k for k in EXPLORER_OPTIONAL if isinstance(x, dict) and k in x)
    if not c.obj(x, keys, where):
        return
    c.str_(x["network"], f"{where}.network", HEX64)
    c.str_(x["sha256"], f"{where}.sha256", HEX64)
    c.bool_(x["pass"], f"{where}.pass")
    if c.num(x["limit"], f"{where}.limit", 0, EXPLORER_LIMIT_MAX) and x["limit"] <= 0:
        c.fail(f"{where}.limit", "must be above 0")
    c.one_of(x["source"], f"{where}.source", EXPLORER_SOURCES)
    r = x["reusedFrom"]
    if r is not None and c.obj(r, ("source", "sha256", "at"), f"{where}.reusedFrom"):
        c.text(r["source"], f"{where}.reusedFrom.source", 200)
        c.str_(r["sha256"], f"{where}.reusedFrom.sha256", HEX64)
        c.ms(r["at"], f"{where}.reusedFrom.at")
    if (x["source"] == "reused") != (r is not None):
        c.fail(f"{where}.reusedFrom", "present exactly when source is reused")
    verdicts = x["verdicts"] if isinstance(x["verdicts"], list) else []
    if c.arr(x["verdicts"], f"{where}.verdicts", 500):
        for i, v in enumerate(verdicts):
            p = f"{where}.verdicts[{i}]"
            if not c.obj(v, EXPLORER_VERDICT_KEYS, p):
                continue
            c.text(v["explorer"], f"{p}.explorer", 300)
            c.one_of(v["kind"], f"{p}.kind", EXPLORER_KINDS)
            c.str_(v["sha256"], f"{p}.sha256", HEX64)
            c.num(v["mean"], f"{p}.mean")
            ok = c.num(v["upper95"], f"{p}.upper95")
            c.int_(v["pairs"], f"{p}.pairs")
            if c.bool_(v["pass"], f"{p}.pass") and ok and is_num(x["limit"]) and v["pass"] != (v["upper95"] <= x["limit"]):
                c.fail(f"{p}.pass", "must be true exactly when upper95 is at most the limit")
    lists = {"measuredOnRecord": []}
    for key in ("failuresOnRecord", "pending", "reasons") + (("measuredOnRecord",) if "measuredOnRecord" in x else ()):
        items = x[key] if isinstance(x[key], list) else []
        lists[key] = items
        if c.arr(x[key], f"{where}.{key}", 64 if key == "reasons" else 500):
            for i, s in enumerate(items):
                c.text(s, f"{where}.{key}[{i}]", 500)
    for s in lists["pending"]:
        if s not in lists["failuresOnRecord"] and s not in lists["measuredOnRecord"]:
            c.fail(f"{where}.pending", f"{s} is not on record")
    st = x.get("settings")
    if "settings" in x and c.map(st, f"{where}.settings"):
        if len(st) > 40:
            c.fail(f"{where}.settings", "more than 40 entries")
        for k, v in st.items():
            if len(k) > 64:
                c.fail(f"{where}.settings", f"key longer than 64 characters: {k[:64]}")
            if isinstance(v, str):
                c.text(v, f"{where}.settings.{k}", 200)
            elif type(v) is not bool and not is_num(v):
                c.fail(f"{where}.settings.{k}", "must be a string, a finite number or a boolean")
    ppo = x.get("ppo")
    if ppo is not None and c.obj(ppo, ("iterations", "wanted"), f"{where}.ppo"):
        okp = c.int_(ppo["iterations"], f"{where}.ppo.iterations") & c.int_(ppo["wanted"], f"{where}.ppo.wanted", 1)
        if okp and x["pass"] is True and ppo["iterations"] < ppo["wanted"]:
            c.fail(f"{where}.ppo", "a passing test's PPO explorer reached its iterations")
    if x.get("source") == "measured" and x["pass"] is True and "ppo" in x and ppo is None:
        c.fail(f"{where}.ppo", "a passing measured test names its PPO explorer's iterations")
    lift = x.get("lifted")
    if lift is not None and c.obj(lift, ("reason", "at", "failedIn"), f"{where}.lifted"):
        if c.text(lift["reason"], f"{where}.lifted.reason", 300) and not lift["reason"].strip():
            c.fail(f"{where}.lifted.reason", "the owner names a reason")
        c.ms(lift["at"], f"{where}.lifted.at")
        if c.arr(lift["failedIn"], f"{where}.lifted.failedIn", 20):
            if not lift["failedIn"]:
                c.fail(f"{where}.lifted.failedIn", "names the earlier failure it lifts")
            for i, s in enumerate(lift["failedIn"]):
                c.text(s, f"{where}.lifted.failedIn[{i}]", 200)
    if x["source"] == "none" and verdicts:
        c.fail(f"{where}.verdicts", "empty when the step did not run")
    if x["pass"] is True:
        if not verdicts or not all(isinstance(v, dict) and v.get("pass") is True for v in verdicts):
            c.fail(f"{where}.pass", "a passing test has verdicts, every one passing")
        if lists["pending"] or lists["reasons"] or x["source"] == "none":
            c.fail(f"{where}.pass", "a passing test ran, with nothing pending and no reasons")
    if x["pass"] is False and not lists["reasons"]:
        c.fail(f"{where}.reasons", "a failing test names its reasons")
    if result in ("promoted", "rolled-back") and x["pass"] is not True:
        c.fail(f"{where}.pass", "a promoted card's explorer test passes")


def v_card(k: Any) -> list[str]:
    c = C()
    keys = ("schema", "version", "parent", "cycleId", "createdAt", "result", "resultAt", "reason", "model", "training", "data", "gate", "personas", "twin", "ab")
    if isinstance(k, dict) and "explorer" in k:
        keys = keys + ("explorer",)
    if not c.obj(k, keys, "card"):
        return c.errors
    c.lit(k["schema"], "schema", "zap-card/1")
    c.str_(k["version"], "version", VERSION)
    if k["parent"] is not None:
        c.str_(k["parent"], "parent", VERSION)
    if k["cycleId"] is not None:
        c.str_(k["cycleId"], "cycleId", CYCLE_ID)
    c.ms(k["createdAt"], "createdAt")
    c.one_of(k["result"], "result", CARD_RESULTS)
    c.ms(k["resultAt"], "resultAt")
    c.text(k["reason"], "reason", 500)
    if c.obj(k["model"], MODEL_INFO_KEYS, "model"):
        _model_info(c, k["model"], "model")
    t = k["training"]
    if t is not None and c.obj(t, ("args", "iterations", "seconds", "seedBase", "leagueFiles", "humanModel", "commit"), "training"):
        if c.arr(t["args"], "training.args", 1000):
            for i, a in enumerate(t["args"]):
                c.str_(a, f"training.args[{i}]", None, 4096)
        c.int_(t["iterations"], "training.iterations")
        c.num(t["seconds"], "training.seconds", 0)
        c.str_(t["seedBase"], "training.seedBase", SEED_BASE)
        if c.arr(t["leagueFiles"], "training.leagueFiles", 1000):
            for i, a in enumerate(t["leagueFiles"]):
                c.str_(a, f"training.leagueFiles[{i}]", None, 4096)
        h = t["humanModel"]
        if h is not None and c.obj(h, ("sha256", "pass"), "training.humanModel"):
            c.str_(h["sha256"], "training.humanModel.sha256", HEX64)
            c.bool_(h["pass"], "training.humanModel.pass")
        if t["commit"] is not None:
            c.str_(t["commit"], "training.commit", COMMIT)
    d = k["data"]
    dkeys = ("records", "valid", "invalid", "test", "validMatches", "linkedSeats", "people", "recordsSha256", "exportDate", "exportSha256", "excluded")
    if d is not None and c.obj(d, dkeys, "data"):
        for f in ("records", "valid", "invalid", "test", "validMatches", "linkedSeats"):
            c.int_(d[f], f"data.{f}")
        if d["people"] is not None:
            c.int_(d["people"], "data.people", 20)
        c.str_(d["recordsSha256"], "data.recordsSha256", HEX64)
        if d["exportDate"] is not None:
            c.date_(d["exportDate"], "data.exportDate")
        if d["exportSha256"] is not None:
            c.str_(d["exportSha256"], "data.exportSha256", HEX64)
        if (d["exportDate"] is None) != (d["exportSha256"] is None):
            c.fail("data.exportSha256", "null exactly when exportDate is null")
        ex = ("unlinked", "flagged", "friends", "auto", "forced", "capped")
        if c.obj(d["excluded"], ex, "data.excluded"):
            for f in ex:
                c.int_(d["excluded"][f], f"data.excluded.{f}")
        if all(is_num(d[f]) for f in ("valid", "invalid", "records")) and d["valid"] + d["invalid"] > d["records"]:
            c.fail("data", "valid plus invalid above records")
    if k["gate"] is not None:
        _gate(c, k["gate"], "gate")
    if k["result"] == "bootstrap" and k["gate"] is not None:
        c.fail("gate", "null for bootstrap")
    p = k["personas"]
    if p is not None and c.obj(p, ("knobsSha256", "orderHolds", "stats"), "personas"):
        c.str_(p["knobsSha256"], "personas.knobsSha256", HEX64)
        c.bool_(p["orderHolds"], "personas.orderHolds")
        stat_keys = ("trucoRate", "bluffRate", "runRate", "reraiseRate", "signalTruth", "vsZap")
        if c.map(p["stats"], "personas.stats"):
            for pid, st in p["stats"].items():
                if pid not in PERSONA_IDS:
                    c.fail("personas.stats", f"unknown persona {pid}")
                elif c.obj(st, stat_keys, f"personas.stats.{pid}"):
                    for f in stat_keys:
                        c.num(st[f], f"personas.stats.{pid}.{f}")
    tw = k["twin"]
    if tw is not None and c.obj(tw, ("sha256", "headToHead", "seedFloor", "seedFloorCycle", "seedNoise"), "twin"):
        c.str_(tw["sha256"], "twin.sha256", HEX64)
        _interval(c, tw["headToHead"], "twin.headToHead", True)
        if tw["seedFloor"] is not None:
            _interval(c, tw["seedFloor"], "twin.seedFloor", True)
        if tw["seedFloorCycle"] is not None:
            c.str_(tw["seedFloorCycle"], "twin.seedFloorCycle", CYCLE_ID)
        if (tw["seedFloor"] is None) != (tw["seedFloorCycle"] is None):
            c.fail("twin.seedFloorCycle", "null exactly when seedFloor is null")
        if tw["seedNoise"] is not None and c.obj(tw["seedNoise"], ("floors", "rms"), "twin.seedNoise"):
            c.int_(tw["seedNoise"]["floors"], "twin.seedNoise.floors", 1)
            c.num(tw["seedNoise"]["rms"], "twin.seedNoise.rms", 0, 0.5)
    if k["ab"] is not None:
        _ab(c, k["ab"], "ab")
    if "explorer" in k:
        _card_explorer(c, k["explorer"], "explorer", k["result"])
    return c.errors


def v_status(s: Any) -> list[str]:
    c = C()
    if not c.obj(s, ("schema", "state", "startedAt", "finishedAt", "updatedAt", "cycleId", "step", "lastPromotion", "message"), "status"):
        return c.errors
    c.lit(s["schema"], "schema", "zap-status/1")
    c.one_of(s["state"], "state", ("ok", "running", "failed"))
    if s["startedAt"] is not None:
        c.ms(s["startedAt"], "startedAt")
    if s["finishedAt"] is not None:
        c.ms(s["finishedAt"], "finishedAt")
    c.ms(s["updatedAt"], "updatedAt")
    if s["cycleId"] is not None:
        c.str_(s["cycleId"], "cycleId", CYCLE_ID)
    c.one_of(s["step"], "step", STEPS)
    lp = s["lastPromotion"]
    if lp is not None and c.obj(lp, ("version", "at"), "lastPromotion"):
        c.str_(lp["version"], "lastPromotion.version", VERSION)
        c.ms(lp["at"], "lastPromotion.at")
    c.text(s["message"], "message", 500)
    if s["state"] == "running" and s["startedAt"] is None:
        c.fail("startedAt", "required while running")
    return c.errors


def v_export(x: Any) -> list[str]:
    c = C()
    if not c.obj(x, ("schema", "date", "createdAt", "partial", "rows", "reports"), "export"):
        return c.errors
    c.lit(x["schema"], "schema", "zap-export/1")
    c.date_(x["date"], "date")
    c.ms(x["createdAt"], "createdAt")
    c.bool_(x["partial"], "partial")
    seen: set[str] = set()
    if c.arr(x["rows"], "rows"):
        for i, r in enumerate(x["rows"]):
            if len(c.errors) >= 50:
                break
            p = f"rows[{i}]"
            if not c.obj(r, ("matchId", "seat", "weight", "flagged", "openDataOptOut", "noAdapt", "group"), p):
                continue
            c.str_(r["matchId"], f"{p}.matchId", UUID)
            c.int_(r["seat"], f"{p}.seat", 0, 3)
            if c.num(r["weight"], f"{p}.weight", 0, 1) and round(r["weight"] * 1000) / 1000 != r["weight"]:
                c.fail(f"{p}.weight", "more than 3 decimals")
            for k in ("flagged", "openDataOptOut", "noAdapt"):
                c.bool_(r[k], f"{p}.{k}")
            c.str_(r["group"], f"{p}.group", GROUP)
            if r["flagged"] is True and r["weight"] != 0:
                c.fail(f"{p}.weight", "must be 0 for a flagged device")
            key = f"{r['matchId']}:{r['seat']}"
            if key in seen:
                c.fail(p, "the same match and seat twice")
            seen.add(key)
    if c.arr(x["reports"], "reports"):
        for i, r in enumerate(x["reports"]):
            p = f"reports[{i}]"
            if not c.obj(r, ("id", "day", "reason", "matchId", "seat", "group"), p):
                continue
            c.int_(r["id"], f"{p}.id", 1)
            c.date_(r["day"], f"{p}.day")
            c.one_of(r["reason"], f"{p}.reason", REPORT_REASONS)
            if r["matchId"] is not None:
                c.str_(r["matchId"], f"{p}.matchId", UUID)
            c.int_(r["seat"], f"{p}.seat", 0, 3)
            if r["group"] is not None:
                c.str_(r["group"], f"{p}.group", GROUP)
    return c.errors


JOB_EXTRA = {
    "retention": ("counts",),
    "calls": ("delivered",),
    "flags": ("sha256", "applied", "ignored", "unresolved", "reviewed"),
    "priors": ("sha256", "imported"),
    "export": ("key", "rows", "reports", "partial", "sha256"),
    "alert": ("sent", "reason"),
}
RETENTION_COUNTS = ("devices", "reports", "flags", "rooms", "members", "calls", "exportGroups", "profiles")


def v_receipt(x: Any) -> list[str]:
    c = C()
    if not c.obj(x, ("schema", "date", "createdAt", "jobs"), "receipt"):
        return c.errors
    c.lit(x["schema"], "schema", "zap-receipt/1")
    c.date_(x["date"], "date")
    c.ms(x["createdAt"], "createdAt")
    if not c.obj(x["jobs"], tuple(JOB_EXTRA), "jobs"):
        return c.errors
    for job, extra in JOB_EXTRA.items():
        j = x["jobs"][job]
        p = f"jobs.{job}"
        if not c.obj(j, ("status", "error") + extra, p):
            continue
        c.one_of(j["status"], f"{p}.status", ("ok", "off", "skipped", "failed"))
        if j["error"] is not None:
            c.text(j["error"], f"{p}.error", 200)
        if j["status"] == "failed" and (not isinstance(j["error"], str) or j["error"] == ""):
            c.fail(f"{p}.error", "a failed job says why")
        if j["status"] in ("ok", "off") and j["error"] is not None:
            c.fail(f"{p}.error", "only a failed or skipped job has an error")
        if job == "retention":
            if c.obj(j["counts"], RETENTION_COUNTS, f"{p}.counts"):
                for k in RETENTION_COUNTS:
                    c.int_(j["counts"][k], f"{p}.counts.{k}")
        elif job == "calls":
            c.int_(j["delivered"], f"{p}.delivered")
        elif job == "flags":
            if j["sha256"] is not None:
                c.str_(j["sha256"], f"{p}.sha256", HEX64)
            for k in ("applied", "ignored", "unresolved", "reviewed"):
                if c.arr(j[k], f"{p}.{k}", MAX_FLAG_OPS):
                    for i, r in enumerate(j[k]):
                        c.str_(r, f"{p}.{k}[{i}]", REF)
        elif job == "priors":
            if j["sha256"] is not None:
                c.str_(j["sha256"], f"{p}.sha256", HEX64)
            c.bool_(j["imported"], f"{p}.imported")
        elif job == "export":
            if j["key"] is not None and c.str_(j["key"], f"{p}.key", EXPORT_KEY) and isinstance(x["date"], str) and j["key"] != f"exports/{x['date']}.json":
                c.fail(f"{p}.key", "not the key of the receipt date")
            c.int_(j["rows"], f"{p}.rows")
            c.int_(j["reports"], f"{p}.reports")
            c.bool_(j["partial"], f"{p}.partial")
            if j["sha256"] is not None:
                c.str_(j["sha256"], f"{p}.sha256", HEX64)
            if (j["key"] is None) != (j["sha256"] is None):
                c.fail(f"{p}.sha256", "null exactly when key is null")
        elif job == "alert":
            c.bool_(j["sent"], f"{p}.sent")
            if j["reason"] is not None:
                c.one_of(j["reason"], f"{p}.reason", ("failed", "stale", "missing"))
            if j["sent"] is True and j["reason"] is None:
                c.fail(f"{p}.reason", "an email sent has a reason")
    return c.errors


def v_priors(x: Any) -> list[str]:
    c = C()
    if not c.obj(x, ("schema", "createdAt", "source", "people", "numbers", "time", "alpha", "segments", "readingSegments"), "priors"):
        return c.errors
    c.lit(x["schema"], "schema", "zap-priors/1")
    c.ms(x["createdAt"], "createdAt")
    c.one_of(x["source"], "source", ("selfplay", "people"))
    if x["source"] == "selfplay" and x["people"] is not None:
        c.fail("people", "null for selfplay")
    if x["source"] == "people":
        c.int_(x["people"], "people", 20)
    if c.obj(x["numbers"], READING_KEYS, "numbers"):
        for k in READING_KEYS:
            n = x["numbers"][k]
            p = f"numbers.{k}"
            if not c.obj(n, ("mean", "strength", "people"), p):
                continue
            if c.num(n["mean"], f"{p}.mean") and not 0 < n["mean"] < 1:
                c.fail(f"{p}.mean", "must be in (0, 1)")
            c.num(n["strength"], f"{p}.strength", 2, 50)
            if n["people"] is not None:
                if x["source"] != "people":
                    c.fail(f"{p}.people", "null for selfplay")
                elif c.int_(n["people"], f"{p}.people", 20) and is_num(x["people"]) and n["people"] > x["people"]:
                    c.fail(f"{p}.people", "above the file people")
    if c.obj(x["time"], ("mu", "tau", "sigma"), "time"):
        c.num(x["time"]["mu"], "time.mu", math.log(100), math.log(120_000))
        c.num(x["time"]["tau"], "time.tau", 0.05, 5)
        c.num(x["time"]["sigma"], "time.sigma", 0.05, 5)
    if c.num(x["alpha"], "alpha") and x["alpha"] <= 0:
        c.fail("alpha", "must be positive")
    if c.obj(x["readingSegments"], SEGMENTS, "readingSegments"):
        for s in SEGMENTS:
            if not c.obj(x["readingSegments"][s], READING_SEGMENT_KEYS, f"readingSegments.{s}"):
                continue
            for k in READING_SEGMENT_KEYS:
                v = x["readingSegments"][s][k]
                if c.num(v, f"readingSegments.{s}.{k}") and not 0 < v < 1:
                    c.fail(f"readingSegments.{s}.{k}", "must be in (0, 1)")
    shapes = c.obj(x["segments"], SEGMENTS, "segments")
    if shapes:
        for s in SEGMENTS:
            if not c.obj(x["segments"][s], PRIOR_KEYS, f"segments.{s}"):
                shapes = False
    if shapes:
        # validatePriors of ai/src/opponent-stats.ts
        if not (is_num(x["alpha"]) and x["alpha"] > 0):
            c.fail("segments", "priors: alpha must be positive")
        for s in SEGMENTS:
            seg = x["segments"][s]
            bad = [k for k in PRIOR_KEYS if not (is_num(seg[k]) and 0 < seg[k] < 1)]
            if bad:
                c.fail("segments", f"priors: {s}.{bad[0]} must be in (0, 1)")
                break
            if abs(seg["run"] + seg["accept"] + seg["reraise"] - 1) > 1e-6:
                c.fail("segments", f"priors: {s} answers must add up to 1")
                break
    return c.errors


def v_flags(x: Any) -> list[str]:
    c = C()
    if not c.obj(x, ("schema", "createdAt", "ops"), "flags"):
        return c.errors
    c.lit(x["schema"], "schema", "zap-flags/1")
    c.ms(x["createdAt"], "createdAt")
    if c.arr(x["ops"], "ops", MAX_FLAG_OPS):
        for i, o in enumerate(x["ops"]):
            if len(c.errors) >= 50:
                break
            p = f"ops[{i}]"
            is_flag = isinstance(o, dict) and o.get("op") == "flag"
            if not c.obj(o, ("ref", "op", "reason", "evidence", "at") if is_flag else ("ref", "op", "at"), p):
                continue
            if c.str_(o["ref"], f"{p}.ref", REF):
                c.date_(o["ref"][:10], f"{p}.ref")
            c.one_of(o["op"], f"{p}.op", ("flag", "confirm", "clear"))
            if is_flag:
                c.one_of(o["reason"], f"{p}.reason", FLAG_REASONS)
                c.str_(o["evidence"], f"{p}.evidence", EVIDENCE, 200)
            if c.ms(o["at"], f"{p}.at") and is_num(x["createdAt"]):
                if o["at"] > x["createdAt"]:
                    c.fail(f"{p}.at", "after createdAt")
                if o["at"] < x["createdAt"] - FLAG_OP_MAX_AGE_MS:
                    c.fail(f"{p}.at", "older than 400 days")
    return c.errors


def _summary_version_v2(c: C, v: dict, p: str) -> None:
    """The fields zap-summary/2 adds to each version entry."""
    if v["twin"] is not None:
        _interval(c, v["twin"], f"{p}.twin", True)
        if isinstance(v["twin"], dict) and is_num(v["twin"].get("pairs")) and v["twin"]["pairs"] < 1:
            c.fail(f"{p}.twin.pairs", "at least 1")
    ps = v["personas"]
    if ps is not None and c.obj(ps, ("pairs", "stats"), f"{p}.personas"):
        c.int_(ps["pairs"], f"{p}.personas.pairs", 1)
        if c.map(ps["stats"], f"{p}.personas.stats"):
            for pid, st in ps["stats"].items():
                if pid not in PERSONA_IDS:
                    c.fail(f"{p}.personas.stats", f"unknown persona {pid}")
                elif c.obj(st, PERSONA_STAT_KEYS, f"{p}.personas.stats.{pid}"):
                    for f in PERSONA_STAT_KEYS:
                        c.num(st[f], f"{p}.personas.stats.{pid}.{f}", 0, 1)
    d = v["data"]
    if d is not None and c.obj(d, ("validMatches", "people"), f"{p}.data"):
        c.int_(d["validMatches"], f"{p}.data.validMatches")
        if d["people"] is not None:
            c.int_(d["people"], f"{p}.data.people", MIN_PEOPLE)


def _summary_v2(c: C, x: dict) -> None:
    """The blocks zap-summary/2 adds at the top level."""
    sn = x["seedNoise"]
    if sn is not None and c.obj(sn, ("floors", "rms"), "seedNoise"):
        c.int_(sn["floors"], "seedNoise.floors", 1)
        c.num(sn["rms"], "seedNoise.rms", 0, 0.5)
    if c.arr(x["scoreboard"], "scoreboard", MAX_SCOREBOARD_ROWS):
        seen: set[str] = set()
        for i, row in enumerate(x["scoreboard"]):
            p = f"scoreboard[{i}]"
            if not c.obj(row, ("variant", "players", "aiVersion", "partnerVersion", "people", "matches", "humanWins"), p):
                continue
            c.one_of(row["variant"], f"{p}.variant", ("paulista", "mineiro"))
            c.one_of(row["players"], f"{p}.players", (2, 4))
            c.str_(row["aiVersion"], f"{p}.aiVersion", AI_LABEL)
            # 1 against 1 has no partner; in 2 against 2 the partner is an AI with its own version.
            if row["players"] == 2 and type(row["players"]) is int and row["partnerVersion"] is not None:
                c.fail(f"{p}.partnerVersion", "null in 1 against 1")
            if row["players"] == 4 and type(row["players"]) is int:
                c.str_(row["partnerVersion"], f"{p}.partnerVersion", AI_LABEL)
            c.int_(row["people"], f"{p}.people", MIN_PEOPLE)
            c.int_(row["matches"], f"{p}.matches", 1)
            c.int_(row["humanWins"], f"{p}.humanWins")
            if is_num(row["humanWins"]) and is_num(row["matches"]) and row["humanWins"] > row["matches"]:
                c.fail(f"{p}.humanWins", "above matches")
            # One person per match in these kinds, so never more people than matches.
            if is_num(row["people"]) and is_num(row["matches"]) and row["people"] > row["matches"]:
                c.fail(f"{p}.people", "above matches")
            key = json.dumps([row["variant"], row["players"], row["aiVersion"], row["partnerVersion"]])
            if key in seen:
                c.fail(p, "the same mode and versions twice")
            seen.add(key)
    dg = x["disagreements"]
    if dg is not None and c.obj(dg, ("types",), "disagreements") and c.arr(dg["types"], "disagreements.types", len(DISAGREEMENT_TYPES)):
        seen_types: list = []
        for i, t in enumerate(dg["types"]):
            p = f"disagreements.types[{i}]"
            if not c.obj(t, ("type", "people", "decisions", "share"), p):
                continue
            c.one_of(t["type"], f"{p}.type", DISAGREEMENT_TYPES)
            if t["type"] in seen_types:
                c.fail(f"{p}.type", "listed twice")
            seen_types.append(t["type"])
            c.int_(t["people"], f"{p}.people", MIN_PEOPLE)
            c.int_(t["decisions"], f"{p}.decisions")
            c.num(t["share"], f"{p}.share", 0, 1)


def v_summary(x: Any) -> list[str]:
    """zap-summary/1, or zap-summary/2 since milestone 7 (validateSummary of shared/cycle-formats.ts)."""
    c = C()
    v2 = isinstance(x, dict) and x.get("schema") == "zap-summary/2"
    if not c.obj(x, SUMMARY_KEYS_V2 if v2 else SUMMARY_KEYS_V1, "summary"):
        return c.errors
    c.one_of(x["schema"], "schema", ("zap-summary/1", "zap-summary/2"))
    c.ms(x["generatedAt"], "generatedAt")
    c.lit(x["minPeople"], "minPeople", 20)
    t = x["training"]
    if c.obj(t, ("state", "finishedAt", "current", "nextAfter"), "training"):
        c.one_of(t["state"], "training.state", ("ok", "running", "failed"))
        if t["finishedAt"] is not None:
            c.ms(t["finishedAt"], "training.finishedAt")
        c.str_(t["current"], "training.current", VERSION)
        if t["nextAfter"] is not None:
            c.ms(t["nextAfter"], "training.nextAfter")
    h = x["humansVsZap"]
    if c.obj(h, ("matches", "humanWins", "since"), "humansVsZap"):
        c.int_(h["matches"], "humansVsZap.matches")
        c.int_(h["humanWins"], "humansVsZap.humanWins")
        if is_num(h["matches"]) and is_num(h["humanWins"]) and h["humanWins"] > h["matches"]:
            c.fail("humansVsZap.humanWins", "above matches")
        if h["since"] is not None:
            c.ms(h["since"], "humansVsZap.since")
        if (h["since"] is None) != (h["matches"] == 0):
            c.fail("humansVsZap.since", "null exactly when there are no matches")
    if c.arr(x["versions"], "versions", MAX_MODELS):
        last = -1
        for i, v in enumerate(x["versions"]):
            p = f"versions[{i}]"
            if not c.obj(v, SUMMARY_VERSION_KEYS_V2 if v2 else SUMMARY_VERSION_KEYS_V1, p):
                continue
            c.str_(v["version"], f"{p}.version", VERSION)
            if c.ms(v["promotedAt"], f"{p}.promotedAt"):
                if v["promotedAt"] < last:
                    c.fail(f"{p}.promotedAt", "versions are listed oldest first")
                last = v["promotedAt"]
            c.one_of(v["result"], f"{p}.result", CARD_RESULTS)
            if v["anchors"] is not None and c.obj(v["anchors"], ANCHORS, f"{p}.anchors"):
                for a in ANCHORS:
                    _interval(c, v["anchors"][a], f"{p}.anchors.{a}")
            if v2:
                _summary_version_v2(c, v, p)
    if v2:
        _summary_v2(c, x)
    ab = x["ab"]
    if ab is not None and c.obj(ab, ("version", "control", "share", "from", "until", "detectablePoints", "result"), "ab"):
        c.str_(ab["version"], "ab.version", VERSION)
        c.str_(ab["control"], "ab.control", VERSION)
        c.num(ab["share"], "ab.share", 0, 0.5)
        c.ms(ab["from"], "ab.from")
        c.ms(ab["until"], "ab.until")
        if ab["detectablePoints"] is not None:
            c.num(ab["detectablePoints"], "ab.detectablePoints", 0)
        r = ab["result"]
        if r is not None and c.obj(r, ("drop", "lo", "hi"), "ab.result"):
            for k in ("drop", "lo", "hi"):
                c.num(r[k], f"ab.result.{k}")
    if c.obj(x["layers"], LAYER_KEYS, "layers"):
        for k in LAYER_KEYS:
            L = x["layers"][k]
            p = f"layers.{k}"
            if not c.obj(L, ("on", "why", "progress"), p):
                continue
            c.bool_(L["on"], f"{p}.on")
            c.text(L["why"], f"{p}.why", 500)
            if c.map(L["progress"], f"{p}.progress"):
                for pk, pv in L["progress"].items():
                    # A people count is public only from MIN_PEOPLE on: under it the cycle writes null.
                    if pv is not None:
                        c.int_(pv, f"{p}.progress.{pk}", MIN_PEOPLE if pk == "people" else 0)
    if c.arr(x["cells"], "cells", 100_000):
        for i, cell in enumerate(x["cells"]):
            p = f"cells[{i}]"
            if not c.obj(cell, ("week", "variant", "players", "people", "matches", "humanWinRate"), p):
                continue
            c.str_(cell["week"], f"{p}.week", WEEK)
            c.one_of(cell["variant"], f"{p}.variant", ("paulista", "mineiro"))
            c.one_of(cell["players"], f"{p}.players", (2, 4))
            c.int_(cell["people"], f"{p}.people", 20)
            c.int_(cell["matches"], f"{p}.matches", 1)
            c.num(cell["humanWinRate"], f"{p}.humanWinRate", 0, 1)
    pt = x["playerTypes"]
    if pt is not None and c.obj(pt, ("k", "ari", "types"), "playerTypes"):
        c.int_(pt["k"], "playerTypes.k", 1, 6)
        c.num(pt["ari"], "playerTypes.ari", -1, 1)
        if c.arr(pt["types"], "playerTypes.types", 6):
            if len(pt["types"]) != pt["k"]:
                c.fail("playerTypes.types", "one entry per type (k)")
            for i, ty in enumerate(pt["types"]):
                p = f"playerTypes.types[{i}]"
                if not c.obj(ty, ("share", "center"), p):
                    continue
                c.num(ty["share"], f"{p}.share", 0, 1)
                if c.obj(ty["center"], READING_KEYS, f"{p}.center"):
                    for k in READING_KEYS:
                        c.num(ty["center"][k], f"{p}.center.{k}", 0, 1)
    return c.errors


VALIDATORS: dict[str, Callable[[Any], list[str]]] = {
    "zap-manifest/1": v_manifest,
    "zap-card/1": v_card,
    "zap-gate/1": v_gate,
    "zap-status/1": v_status,
    "zap-export/1": v_export,
    "zap-receipt/1": v_receipt,
    "zap-priors/1": v_priors,
    "zap-flags/1": v_flags,
    "zap-summary/1": v_summary,
    "zap-summary/2": v_summary,
}


def validate(schema: str, x: Any) -> list[str]:
    return VALIDATORS[schema](x)


def check(schema: str, x: Any) -> dict:
    errors = validate(schema, x)
    if errors:
        raise FormatError(schema, errors)
    return x


def load(schema: str, data: bytes) -> dict:
    limit = SIZE_LIMITS[schema]
    if len(data) > limit:
        raise FormatError(schema, [f"{len(data)} bytes, over the limit of {limit}"])
    try:
        x = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise FormatError(schema, [f"not JSON: {e}"]) from e
    return check(schema, x)


def dumps(x: Any) -> bytes:
    """Compact JSON as stored in the buckets."""
    return (json.dumps(x, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode()
