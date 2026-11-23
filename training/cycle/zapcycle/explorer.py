"""The explorer test as a step of the cycle gate (contract item 6 of milestone 6).

A candidate whose file can read the in-match statistics (features v2 with a finite safety net in
meta.adapt) plays with them once AI_ADAPT is on. With [gate] stats = "live" and [explorer] on, the
step does against that file what _local/m6/run-feints.sh did against one file, after the gate
passed (or was forced to pass in a local profile):

1. a scripted search ranked by the adaptation part over the original grid and the fresh family that
   no training league draws (ai/bench/explorer.ts --stage search --baseline ablated --pool all);
2. the chosen explorer on fresh deals, with the best one from outside the training family when the
   chosen one is inside it (--stage fresh);
3. every explorer the cycle has on record, measured again against this file on fresh deals: those
   that failed against an earlier file and those that passed against one (--remeasure for scripted
   ones, explorer-trained.ts --stage measure for trained ones), as run-feints.sh measured every
   earlier explorer again;
4. a PPO explorer trained against this file as served (training/train.py --league-as-served, from
   the twin folded by training/explorer_init.py) for [explorer] trained_iters iterations, then
   measured on fresh deals (explorer-trained.ts --stage measure); the step fails when the time left
   cannot hold its whole cap trained_hours, and does not pass when it stopped short of its
   iterations;
5. the control explorer on record (trained the same way against the twin) measured against this
   file next to the PPO explorer (explorer-trained.ts --stage control);
6. the criterion of ai/bench/criterion.ts (explorer-trained.ts --stage facts): every verdict's
   one-sided 95% upper bound of the adaptation part at most [explorer] limit, read again here from
   the result files, and no explorer on record left without a verdict against this file.

Verdicts are kept per network (network_hash: shapes, features, weights, safety net and priors,
without meta.version and the other metadata). A passing verdict for the same network is reused
instead of steps 1 to 6; the explorers recorded as failing after it, or never measured by it, are
still measured again. The verdict of facts.json ai.adaptation.explorer.criterion counts when the
files it names are on disk (facts_verdict).

The record lives in state.json: explorerFailures (every explorer that failed, with each file it
failed against) and explorerMeasured (every explorer measured, with each file). Both start from
facts.json (the failures of ai.adaptation.explorer.criterion.history and ai.adaptation.history, and
every verdict of the criterion: the scripted explorers with their specs, the trained explorers and
the control with their files) and only grow. Every card of a reading candidate lists them
(explorer.failuresOnRecord and explorer.measuredOnRecord).

A failure against the exact network is final: a network (or file) that failed is not measured again
and never promoted, so a step cannot be run until one sample passes. Only the owner lifts that, with
--lift-failure, which the card records (explorer.lifted). publish refuses a reading file without a
passing verdict of this step for its network whatever the config says (promotable).

Every seed comes from the cycle id ([explorer] seeds = "cycle"): SHA-256 of
"<cycleId>:explorer:<part>", 64 hex for the benches and its first 2 for train.py's --seed-base.
Within a cycle each attempt starts after the deals of the attempts before it (explorer.ts offsets),
and each attempt has its own folder, explorer/<cycleId>/<attempt>/, so the files of an explorer on
record stay.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import struct
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from . import proc
from .config import ROOT, Config, explorer_size_problems
from .core import Cycle, plain, read_json, rel, sha256_file, write_json, zapw_header
from .errors import CycleError

EXPLORER_TS = "ai/bench/explorer.ts"
TRAINED_TS = "ai/bench/explorer-trained.ts"
INIT_PY = "training/explorer_init.py"
# The owner's rule (DEPLOY.md section 9.1): no explorer may gain more than 1 point from the reading.
# [explorer] limit may be tighter, never looser; the guard holds this bound whatever the config says.
LIMIT_MAX = 0.01
FACTS_FILE = ROOT / "facts.json"
FACTS_SOURCE = "facts.json ai.adaptation.explorer.criterion"
KINDS = ("scripted", "trained", "control")
# What in a model file's meta changes how it plays: the safety net and the opponent priors.
PLAYING_META = ("adapt", "priors", "priorsSha256")
# The PPO explorer's recipe: training/runs/m6-explorer-r/args.json (_local/m6/run-feints.sh step 4),
# with the sizes, seeds and cap of [explorer].
RECIPE = [
    "--imitation-iters", "0",
    "--league-mix", "snapshots=1",
    "--league-as-served",
    "--league-every", "100000",
    "--two-styles", "1",
    "--partner-swap", "0",
    "--four-players", "0.5",
    "--mineiro", "0.5",
    "--random-options", "0",
    "--no-stats-share", "0",
    "--v1-model", "ai/models/bootstrap/zap-v1.zapw",
    "--v1-manifest", "ai/models/bootstrap/manifest.json",
    "--heuristic-params", "ai/models/heuristic-tuned.json",
    "--lr", "0.0003",
    "--entropy", "0.01",
    "--magnet-kl", "0.05",
    "--magnet-every", "10",
    "--adapt-beta", "0",
    "--episode", "match",
    "--panel-every", "0",
]
# Hours kept after the PPO explorer for its measure, the control and the criterion.
AFTER_TRAINING_H = 0.5
LIFT_FLAG = "--lift-failure"


# The file -----------------------------------------------------------------------------------------


def is_safety_net(a: Any) -> bool:
    """isSafetyNet of ai/src/safety.ts: finite bmax and nHalf above 0."""
    if not isinstance(a, dict):
        return False
    vals = (a.get("bmax"), a.get("nHalf"))
    return all(type(x) in (int, float) and math.isfinite(x) and x > 0 for x in vals)


def can_read(header: dict) -> bool:
    """A file that reads the in-match statistics when the room serves them live (servesLiveStats of
    ai/src/safety.ts for features v2): features v2 with a finite safety net."""
    return header.get("features") == "v2" and is_safety_net((header.get("meta") or {}).get("adapt"))


def network_hash(path: Path) -> str:
    """SHA-256 of what plays in a model file: the header without meta (shapes, features, tensor
    layout), the meta that changes play (safety net and priors), and the tensor bytes. meta.version,
    meta.iteration, meta.note and any other metadata are left out, so the same network exported
    again under another version name has the same hash."""
    data = Path(path).read_bytes()
    magic, version, hlen = struct.unpack_from("<III", data, 0)
    if magic != 0x5750415A or version != 1:
        raise CycleError(f"{path}: not a Zap model file")
    header = json.loads(data[12 : 12 + hlen].decode())
    start = 12 + hlen + (4 - hlen % 4) % 4
    meta = header.get("meta") or {}
    plays = {k: v for k, v in header.items() if k != "meta"}
    plays["meta"] = {k: meta.get(k) for k in PLAYING_META}
    h = hashlib.sha256(json.dumps(plays, sort_keys=True, separators=(",", ":")).encode())
    h.update(data[start:])
    return h.hexdigest()


def step_due(cfg: Config, features: str, adapt: Any) -> bool:
    """Whether a candidate with these features and safety net runs the step (train.py reserves its time)."""
    x = getattr(cfg, "explorer", None) or {}
    return features == "v2" and is_safety_net(adapt) and cfg.gate.get("stats") == "live" and x.get("on") is True


def config_mismatch(cfg: Config, version: str, features: str, adapt: Any) -> str | None:
    """Why a cycle cannot end in a promotion, known before it trains: the version in play can read,
    so its candidate will (it inherits the safety net), and the config keeps the step from running,
    so publish would refuse the candidate after the whole training. None when the two agree."""
    if not (features == "v2" and is_safety_net(adapt)) or step_due(cfg, features, adapt):
        return None
    x = getattr(cfg, "explorer", None) or {}
    return (f"config mismatch: the version in play, {version}, can read the in-match statistics (features v2, safety net {json.dumps(adapt)}), so its candidate will too, "
            f"and with [gate] stats = \"{cfg.gate.get('stats')}\" and [explorer] on = {x.get('on')} the explorer test cannot run: publish would refuse the candidate after the whole training. "
            f"Set [gate] stats = \"live\" and [explorer] on = true in {Path(cfg.path).name}, or roll back to a version that cannot read (DEPLOY.md section 9.5).")


def seed(cycle_id: str, part: str) -> str:
    return hashlib.sha256(f"{cycle_id}:explorer:{part}".encode()).hexdigest()


def metric_lines(run: Path) -> int:
    """Iterations a training run logged (one line of metrics.jsonl each, warm-up included), as zapcycle/train.py iterations."""
    p = Path(run) / "metrics.jsonl"
    return sum(1 for line in p.read_text().splitlines() if line.strip()) if p.exists() else 0


# Explorer labels (ai/src/styles.ts scheduleLabel and explorerLabel) ----------------------------------


def schedule_label(e: dict) -> str:
    at = "e" if e.get("trigger") == "evidence" else ""
    if e.get("cycle"):
        return f"{e['a']}<>{e['b']}@{at}{e['k']}"
    if e.get("k2") is not None:
        return f"{e['a']}>{e['b']}>{e.get('c') or e['a']}@{at}{e['k']},{e['k2']}"
    return f"{e['a']}>{e['b']}@{at}{e['k']}"


def explorer_label(e: dict) -> str:
    p = e.get("partner")
    return f"{schedule_label(e)}/" + (f"own:{schedule_label(e['mate'])}" if p == "own" else str(p))


STYLE = r"[A-Za-z]+"


def _parse_schedule(s: str) -> dict:
    m = re.fullmatch(rf"({STYLE})(<>|>)({STYLE})(?:>({STYLE}))?@(e?)(\d+)(?:,(\d+))?", s)
    if not m:
        raise CycleError(f"not an explorer schedule: {s}")
    a, sep, b, c, ev, k, k2 = m.groups()
    out: dict = {"a": a, "b": b, "k": int(k), "trigger": "evidence" if ev else "hand"}
    if sep == "<>":
        if c or k2:
            raise CycleError(f"not an explorer schedule: {s}")
        out["cycle"] = True
    elif c or k2:
        if not (c and k2):
            raise CycleError(f"not an explorer schedule: {s}")
        out.update(c=c, k2=int(k2))
    return out


def parse_label(label: str) -> dict:
    """The explorer spec of a label (the inverse of explorer_label); refused when it does not give the label back."""
    sched, _, partner = label.partition("/")
    spec = _parse_schedule(sched)
    if partner.startswith("own:"):
        spec.update(partner="own", mate=_parse_schedule(partner[4:]))
    elif partner in ("same", "v1"):
        spec["partner"] = partner
    else:
        raise CycleError(f"not an explorer label: {label}")
    if explorer_label(spec) != label:
        raise CycleError(f"not an explorer label: {label}")
    return spec


def _spec_or_none(label: str) -> dict | None:
    try:
        return parse_label(label)
    except CycleError:
        return None


# Reading the benches' result files (the parts of criterion.ts the cycle needs) ----------------------


def _abs(p: str | Path) -> Path:
    q = Path(p)
    return q if q.is_absolute() else ROOT / q


def run_of(model_path: str | Path) -> Path:
    """ai/bench/bench-util.ts runOf: <run>/export/x.zapw, <run>/league/x.zapw and <run>/x.zapw give <run>."""
    d = Path(model_path).parent
    return d.parent if d.name in ("export", "league") else d


def _part(d: dict) -> dict:
    return {"mean": float(d["mean"]), "upper95": float(d["upper95"]), "pairs": int(d["pairs"])}


def _verdict(explorer: str, kind: str, file: Path, sha: str, part: dict, spec: dict | None = None) -> dict:
    v = {"explorer": explorer, "kind": kind, "file": rel(file), "sha256": sha, "adaptationPart": _part(part)}
    if spec:
        v["spec"] = spec
    return v


def read_results(files) -> list[dict]:
    """Every verdict the result files hold, as ai/bench/explorer-trained.ts reads them
    (scriptedMeasured, trainedMeasured, controlMeasured): the explorer, its kind, the file, the
    SHA-256 of the adaptive file it measured and its adaptation part."""
    out: list[dict] = []
    for f in files:
        p = _abs(f)
        r = read_json(p)
        facts = r.get("facts") or {}
        e = facts.get("explorer")
        if isinstance(e, dict) and isinstance(e.get("split"), dict):
            own = r.get("attempt") or (e.get("attempts") or [{}])[-1]
            sha = e["models"]["adaptive"]["sha256"]
            out.append(_verdict(own["explorer"], "scripted", p, sha, e["split"]["adaptationPart"], e.get("chosen")))
            o = e.get("outsideTraining")
            if isinstance(o, dict):
                out.append(_verdict(own["outside"]["explorer"], "scripted", p, sha, o["split"]["adaptationPart"], o.get("chosen")))
        t = facts.get("explorer.trained")
        if isinstance(t, dict):
            out.append(_verdict(t["explorer"], "trained", p, t["models"]["adaptive"]["sha256"], t["fresh"]["adaptationPart"]))
        c = facts.get("explorer.control")
        if isinstance(c, dict):
            out.append(_verdict(c["explorer"], "control", p, c["models"]["adaptive"]["sha256"], c["fresh"]["control"]["adaptationPart"]))
    return out


def eval_files(d: Path) -> list[Path]:
    """The result files of an eval folder that the criterion reads: scripted attempts, the trained
    explorer, the control, and history/."""
    num = lambda f: int(re.search(r"(\d+)", f.name).group(1))  # noqa: E731
    files = sorted(d.glob("explorer-fresh-*.json"), key=num)
    files += [d / n for n in ("explorer-trained.json", "explorer-control.json") if (d / n).exists()]
    files += sorted((d / "history").glob("*.json")) if (d / "history").is_dir() else []
    return files


def ts_verdicts(crit: dict) -> list[dict]:
    """The verdicts of an explorer.criterion value, in the order criterion.ts lists them."""
    v = crit.get("verdicts") or {}
    out = [x for s in v.get("scripted") or [] for x in s.get("explorers") or []]
    out += [v["trained"]] if v.get("trained") else []
    out += list(v.get("otherTrained") or [])
    out += [v["control"]] if v.get("control") else []
    return out


def _key(v: dict) -> tuple[str, float]:
    return (v["explorer"], round(float(v["adaptationPart"]["upper95"]), 6))


def iso_ms(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def pts(x: float, digits: int = 2) -> str:
    """A share as points with half away from zero (the texts' rounding)."""
    k = 10**digits
    v = math.floor(abs(x) * 100 * k + 0.5 + 1e-9) / k
    return f"{'-' if x < 0 and v != 0 else ''}{v:.{digits}f}"


def trained_files(t: dict) -> dict | None:
    """What a later measure of a trained explorer needs, from its explorer.trained value: the
    explorer, the start it was folded from, its run folder (args.json, metrics.jsonl) and the file it
    trained against."""
    try:
        files = {"explorer": t["explorer"], "start": t["start"], "run": t["training"]["run"], "against": t["training"]["against"]["path"]}
    except (KeyError, TypeError):
        return None
    return files if all(isinstance(v, str) and v for v in files.values()) else None


# Verdicts that may be reused ----------------------------------------------------------------------


def recheck(rec: dict) -> list[str]:
    """Problems that keep a stored verdict from being reused: a missing file, a model file that no
    longer has its SHA-256 or network, or result files that no longer hold the same verdicts."""
    models = rec.get("models") or []
    files = rec.get("files") or []
    missing = [m["path"] for m in models if not _abs(m["path"]).exists()] + [f for f in files if not _abs(f).exists()]
    if missing:
        return [f"missing on this machine: {', '.join(missing)}"]
    out = []
    for m in models:
        if sha256_file(_abs(m["path"])) != m["sha256"]:
            out.append(f"{m['path']} no longer has the SHA-256 {m['sha256'][:8]}")
        elif network_hash(_abs(m["path"])) != rec["network"]:
            out.append(f"{m['path']} holds another network")
    shas = {m["sha256"] for m in models}
    got = sorted(_key(v) for v in read_results(files) if v["sha256"] in shas)
    want = sorted(_key(v) for v in rec.get("verdicts") or [])
    if not out and got != want:
        out.append("the result files do not hold the verdicts recorded with them")
    return out


def _criterion(path: Path) -> dict | None:
    crit = (((read_json(path).get("ai") or {}).get("adaptation") or {}).get("explorer") or {}).get("criterion")
    return crit if isinstance(crit, dict) else None


def facts_verdict(facts_path: Path | None = None) -> dict | None:
    """The verdict of facts.json ai.adaptation.explorer.criterion as a stored verdict: the served
    model and the result files its verdicts come from (a scripted attempt per verdict file, the
    trained explorer, the others trained for earlier files, the control). None without one; with
    'problems' when a file is missing or does not agree, so it is not reused."""
    path = facts_path or FACTS_FILE
    if not path.exists():
        return None
    crit = _criterion(path)
    if crit is None or not isinstance(crit.get("servedModel"), dict):
        return None
    served = crit["servedModel"]
    ev = run_of(served["path"]) / "eval"
    vs = crit.get("verdicts") or {}
    files = [s["file"] for s in vs.get("scripted") or []]
    files += [str(ev / "explorer-trained.json")] if vs.get("trained") else []
    files += [o["file"] for o in vs.get("otherTrained") or []]
    files += [str(ev / "explorer-control.json")] if vs.get("control") else []
    rec = {
        "source": FACTS_SOURCE,
        "cycleId": None,
        "at": iso_ms(crit["measuredAt"]),
        "network": None,
        "models": [{"path": served["path"], "sha256": served["sha256"], "adapt": served.get("adapt")}],
        "files": files,
        "limit": float(crit.get("requirement", LIMIT_MAX)),
        "verdicts": [],
        "pass": False,
    }
    missing = [p for p in [served["path"], *files] if not _abs(p).exists()]
    if missing:
        return {**rec, "problems": [f"missing on this machine: {', '.join(missing)}"]}
    if sha256_file(_abs(served["path"])) != served["sha256"]:
        return {**rec, "problems": [f"{served['path']} does not have the SHA-256 of the criterion"]}
    verdicts = [v for v in read_results(files) if v["sha256"] == served["sha256"]]
    if sorted(_key(v) for v in verdicts) != sorted(_key(v) for v in ts_verdicts(crit)):
        return {**rec, "problems": ["the result files do not hold the verdicts of the criterion"]}
    for v in verdicts:
        v["pass"] = v["adaptationPart"]["upper95"] <= LIMIT_MAX
    ok = bool(crit.get("pass")) and not crit.get("pendingRemeasure") and bool(verdicts) and all(v["pass"] for v in verdicts)
    return {**rec, "network": network_hash(_abs(served["path"])), "verdicts": verdicts, "pass": ok}


def verdicts_dir(cyc: Cycle) -> Path:
    return cyc.cfg.data_dir / "explorer" / "verdicts"


def find_reusable(cyc: Cycle, network: str, facts_path: Path | None = None) -> tuple[dict | None, list[str]]:
    """The newest passing verdict for this network whose files are all on disk and agree: the
    cycle's own (data/<profile>/explorer/verdicts/<network>.json) or the one of facts.json. Also
    notes on the verdicts found and not reusable."""
    notes: list[str] = []
    found: list[dict] = []
    p = verdicts_dir(cyc) / f"{network}.json"
    if p.exists():
        rec = read_json(p)
        probs = recheck(rec) if rec.get("pass") else ["it did not pass"]
        if probs:
            notes.append(f"{rel(p)}: {'; '.join(probs)}")
        else:
            found.append(rec)
    fv = facts_verdict(facts_path)
    if fv is not None:
        if fv.get("problems"):
            notes.append(f"{FACTS_SOURCE} (SHA-256 {fv['models'][0]['sha256'][:8]}): {'; '.join(fv['problems'])}")
        elif fv["network"] == network and fv["pass"]:
            found.append(fv)
    return (max(found, key=lambda r: r["at"]) if found else None), notes


# The record: explorers that failed against an earlier file, and every explorer measured --------------


def _ms_or_none(s: Any) -> int | None:
    try:
        return iso_ms(s) if isinstance(s, str) else None
    except ValueError:
        return None


def _facts_specs(ad: dict) -> dict[str, dict]:
    """Explorer specs facts.json keeps (chosen of a kept explorer value), by label."""
    specs: dict[str, dict] = {}
    values = [ad.get("explorer") or {}] + [((h or {}).get("keys") or {}).get("explorer") or {} for h in (ad.get("history") or {}).values()]
    for e in values:
        for s in (e.get("chosen"), (e.get("outsideTraining") or {}).get("chosen")):
            if isinstance(s, dict):
                specs[explorer_label(s)] = s
    return specs


def facts_failures(facts_path: Path | None = None) -> list[dict]:
    """The explorers facts.json records as failing against an earlier file: the verdicts with pass
    false in ai.adaptation.explorer.criterion.history, and the scripted attempts whose adaptation
    part failed in the explorer values kept in ai.adaptation.history. Each with its spec when facts
    hold it (chosen of a kept explorer value), else parsed from its label, and the path of the file
    it failed against when facts name it."""
    path = facts_path or FACTS_FILE
    if not path.exists():
        return []
    ad = ((read_json(path).get("ai") or {}).get("adaptation") or {})
    crit = (ad.get("explorer") or {}).get("criterion") or {}
    specs = _facts_specs(ad)
    attempt_at: dict[int, int | None] = {}
    attempt_sha: dict[int, str] = {}
    values = [ad.get("explorer") or {}] + [((h or {}).get("keys") or {}).get("explorer") or {} for h in (ad.get("history") or {}).values()]
    for e in values:
        for a in e.get("attempts") or []:
            if isinstance(a.get("attempt"), int):
                attempt_at.setdefault(a["attempt"], _ms_or_none(e.get("measuredAt")))
    for m in crit.get("history") or []:
        if m.get("kind") == "scripted" and isinstance(m.get("attempt"), int) and m.get("model"):
            attempt_sha[m["attempt"]] = m["model"]["sha256"]
    out: dict[tuple[str, str], dict] = {}

    def add(kind: str, label: str, sha: str | None, adapt: Any, upper: float, at: int | None, source: str, model_path: str | None = None) -> None:
        if not sha:
            return
        out.setdefault((label, sha), {"kind": kind, "explorer": label, "sha256": sha, "path": model_path, "adapt": adapt, "upper95": upper, "at": at, "source": source})

    for m in crit.get("history") or []:
        for v in m.get("explorers") or []:
            if v.get("pass") is False:
                at = attempt_at.get(m.get("attempt")) if m.get("kind") == "scripted" else None
                model = m.get("model") or {}
                add(m.get("kind", "scripted"), v["explorer"], model.get("sha256"), m.get("adapt"), float(v["adaptationPart"]["upper95"]), at, f"{FACTS_SOURCE}.history", model.get("path"))
    for sha, h in (ad.get("history") or {}).items():
        e = ((h or {}).get("keys") or {}).get("explorer") or {}
        for a in e.get("attempts") or []:
            part = a.get("adaptationPart") or {}
            failed = a.get("passAdaptationPart") is False or (isinstance(part.get("upper95"), (int, float)) and part["upper95"] > LIMIT_MAX)
            if failed and a.get("explorer"):
                add("scripted", a["explorer"], attempt_sha.get(a.get("attempt"), sha), a.get("adapt"), float(part.get("upper95", math.nan)), _ms_or_none(e.get("measuredAt")), f"facts.json ai.adaptation.history.{sha[:8]}.keys.explorer")
    entries = []
    for (label, sha), f in out.items():
        spec = specs.get(label)
        if f["kind"] == "scripted" and spec is None:
            spec = _spec_or_none(label)
        entries.append({**f, "spec": spec})
    return entries


def facts_measured(facts_path: Path | None = None) -> list[dict]:
    """Every explorer the criterion of facts.json measured against the file it judged
    (ai.adaptation.explorer.criterion.verdicts), passing or not, as run-feints.sh had them: the
    scripted ones with their specs (from their result files when on disk, else from facts or the
    label), the trained ones with the files a later measure needs (explorer, start, run folder, the
    file it trained against), and the control with its file and run folder."""
    path = facts_path or FACTS_FILE
    if not path.exists():
        return []
    ad = ((read_json(path).get("ai") or {}).get("adaptation") or {})
    ex = ad.get("explorer") or {}
    crit = ex.get("criterion") or {}
    served = crit.get("servedModel") or {}
    vs = crit.get("verdicts")
    if not isinstance(vs, dict) or not served.get("sha256"):
        return []
    at = _ms_or_none(crit.get("measuredAt"))
    specs = _facts_specs(ad)

    def item(kind: str, v: dict, spec: dict | None, files: dict | None) -> dict:
        return {"kind": kind, "explorer": v["explorer"], "spec": spec, "files": files, "sha256": served["sha256"], "path": served.get("path"), "adapt": served.get("adapt"), "upper95": float(v["adaptationPart"]["upper95"]), "at": at, "source": FACTS_SOURCE}

    out = []
    for s in vs.get("scripted") or []:
        in_file: dict[str, dict] = {}
        p = _abs(s["file"]) if isinstance(s.get("file"), str) else None
        if p is not None and p.exists():
            try:
                in_file = {r["explorer"]: r["spec"] for r in read_results([p]) if r.get("spec")}
            except (KeyError, TypeError, ValueError):
                in_file = {}
        for v in s.get("explorers") or []:
            label = v["explorer"]
            out.append(item("scripted", v, in_file.get(label) or specs.get(label) or _spec_or_none(label), None))
    main = ex.get("trained") or {}
    t = vs.get("trained")
    if t:
        out.append(item("trained", t, None, trained_files(main) if main.get("explorer") == t["explorer"] else None))
    for o in vs.get("otherTrained") or []:
        files = None
        p = _abs(o["file"]) if isinstance(o.get("file"), str) else None
        if p is not None and p.exists():
            files = trained_files(((read_json(p).get("facts") or {}).get("explorer.trained")) or {})
        if files is None:
            # From facts alone: the explorer's own run folder, the start every explorer of this recipe folds from.
            guess = {"explorer": o["explorer"], "start": main.get("start"), "run": str(Path(o["explorer"]).parent), "against": (o.get("trainedAgainst") or {}).get("path")}
            files = guess if all(isinstance(x, str) and x for x in guess.values()) else None
        out.append(item("trained", o, None, files))
    c = vs.get("control")
    if c:
        ctl = ex.get("control") or {}
        run = (ctl.get("training") or {}).get("run")
        out.append(item("control", c, None, {"explorer": c["explorer"], "run": run} if ctl.get("explorer") == c["explorer"] and isinstance(run, str) else None))
    return out


def _failure_id(kind: str, label: str) -> str:
    return f"{kind}:{label}"


def _add(state: dict, key: str, items_key: str, last_key: str, kind: str, label: str, item: dict, spec: dict | None, files: dict | None) -> bool:
    rec = list(state.get(key) or [])  # a new list: the state's default is shared
    state[key] = rec
    fid = _failure_id(kind, label)
    e = next((x for x in rec if x["id"] == fid), None)
    if e is None:
        e = {"id": fid, "kind": kind, "explorer": label, "spec": spec, "files": files, items_key: [], "recordedAt": item.get("at"), last_key: item.get("at")}
        rec.append(e)
    if spec and not e.get("spec"):
        e["spec"] = spec
    if files and not e.get("files"):
        e["files"] = files
    if any(f["sha256"] == item["sha256"] for f in e[items_key]):
        return False
    e[items_key].append(item)
    ats = [f["at"] for f in e[items_key] if isinstance(f.get("at"), int)]
    e["recordedAt"] = min(ats) if ats else None
    e[last_key] = max(ats) if ats else None
    return True


def record_failure(state: dict, kind: str, label: str, failed: dict, spec: dict | None = None, files: dict | None = None) -> bool:
    """Adds one failure to state.explorerFailures: one entry per explorer, with every file it failed against."""
    return _add(state, "explorerFailures", "failed", "lastFailedAt", kind, label, failed, spec, files)


def record_measured(state: dict, kind: str, label: str, measured_: dict, spec: dict | None = None, files: dict | None = None) -> bool:
    """Adds one measure to state.explorerMeasured: one entry per explorer, with every file it was measured against."""
    return _add(state, "explorerMeasured", "measured", "lastMeasuredAt", kind, label, measured_, spec, files)


def _network_of(path: str | None, sha: str) -> str | None:
    """The network of the file a fact names, when it is on disk with that SHA-256."""
    if not path:
        return None
    p = _abs(path)
    try:
        return network_hash(p) if p.exists() and sha256_file(p) == sha else None
    except (OSError, CycleError, ValueError, struct.error):
        return None


def seed_record(cyc: Cycle, facts_path: Path | None = None) -> int:
    """Merges facts.json into the record, once per explorer and file: the failures, and every verdict
    of the criterion. Returns how many were new."""
    new = 0
    nets: dict[str, str | None] = {}
    for f in facts_failures(facts_path):
        net = nets.setdefault(f["sha256"], _network_of(f.get("path"), f["sha256"]))
        failed = {"sha256": f["sha256"], "network": net, "adapt": f["adapt"], "upper95": f["upper95"], "at": f["at"], "source": f["source"]}
        new += record_failure(cyc.state, f["kind"], f["explorer"], failed, f.get("spec"))
    for m in facts_measured(facts_path):
        net = nets.setdefault(m["sha256"], _network_of(m.get("path"), m["sha256"]))
        item = {"sha256": m["sha256"], "network": net, "adapt": m["adapt"], "upper95": m["upper95"], "at": m["at"], "source": m["source"]}
        new += record_measured(cyc.state, m["kind"], m["explorer"], item, m.get("spec"), m.get("files"))
        if m["upper95"] > LIMIT_MAX:
            new += record_failure(cyc.state, m["kind"], m["explorer"], item, m.get("spec"), m.get("files"))
    if new:
        cyc.state.save()
    return new


def failures(cyc: Cycle) -> list[dict]:
    return list(cyc.state.get("explorerFailures") or [])


def measured(cyc: Cycle) -> list[dict]:
    return list(cyc.state.get("explorerMeasured") or [])


def on_record(cyc: Cycle) -> list[dict]:
    """Every explorer on record, one entry each: those that failed against an earlier file first
    (failedOnRecord true), then those only ever measured passing, with the spec and files of either
    record."""
    out: dict[str, dict] = {}
    for e in failures(cyc):
        out[e["id"]] = {**e, "failedOnRecord": True}
    for e in measured(cyc):
        o = out.get(e["id"])
        if o is None:
            out[e["id"]] = {**e, "failedOnRecord": False}
            continue
        if e.get("spec") and not o.get("spec"):
            o["spec"] = e["spec"]
        if e.get("files") and not o.get("files"):
            o["files"] = e["files"]
    return list(out.values())


def failed_against(cyc: Cycle, sha: str, net: str) -> list[dict]:
    """The failures on record against this very network or file."""
    return [
        {"explorer": e["explorer"], "kind": e["kind"], "upper95": f.get("upper95"), "at": f.get("at"), "source": f.get("source")}
        for e in failures(cyc)
        for f in e["failed"]
        if f.get("sha256") == sha or (f.get("network") is not None and f.get("network") == net)
    ]


def final_why(hits: list[dict]) -> str:
    where = ", ".join(sorted({str(h.get("source") or "an earlier step") for h in hits}))
    which = "; ".join(f"{h['explorer']} ({h['kind']}), upper bound {pts(h['upper95'])} points" if isinstance(h.get("upper95"), (int, float)) else f"{h['explorer']} ({h['kind']})" for h in hits)
    return (f"This network failed the explorer test in {where}: {which}. A failure against the exact network is final, since measuring it again until one sample passes "
            f"would defeat the bound by selection; only the owner may lift it ({LIFT_FLAG}), and the card records that.")


def lifted_ok(res: dict | None, net: str) -> bool:
    """The step that judged this network ran in full with the owner's lift of its earlier failure."""
    lift = (res or {}).get("lifted")
    return bool(isinstance(lift, dict) and lift.get("network") == net and res.get("ran") and res.get("source") == "measured")


# Commands -------------------------------------------------------------------------------------------


def search_cmd(x: dict, A: str, T: str, cycle_id: str, out: str) -> list[str]:
    return ["node", EXPLORER_TS, "--stage", "search", "--pool", str(x["pool"]), "--baseline", "ablated", "--adaptive", A, "--twin", T, "--seed", seed(cycle_id, "search"),
            "--threads", str(x["threads"]), "--round-pairs", str(x["round_pairs"]), "--grid-limit", str(x["grid_limit"]), "--attempt", "1", "--out", out]


def fresh_cmd(x: dict, A: str, T: str, cycle_id: str, attempt: int, spec: str, out: str, remeasure: bool = False) -> list[str]:
    return ["node", EXPLORER_TS, "--stage", "fresh", *(["--remeasure"] if remeasure else []), "--spec", spec, "--out", out, "--adaptive", A, "--twin", T,
            "--pairs", str(x["fresh_pairs"]), "--seed", seed(cycle_id, "fresh"), "--threads", str(x["threads"]), "--attempt", str(attempt)]


def init_cmd(T: str, priors: str, out: str) -> list[str]:
    return ["python", INIT_PY, "--twin", T, "--priors", priors, "--out", out]


def ppo_cmd(x: dict, run: str, A: str, priors: str, init: str, hidden: str, cycle_id: str, hours: float) -> list[str]:
    return ["python", "training/train.py", "--run", run, "--features", "v2-self", "--priors", priors, "--init-actor", init,
            "--critic-warmup", str(x["trained_critic_warmup"]), "--iters", str(x["trained_iters"]), "--decisions", str(x["trained_decisions"]),
            "--workers", str(x["trained_workers"]), "--threads", str(x["trained_threads"]), "--league-fixed", A, "--eval-served", A,
            "--eval-every", str(x["trained_eval_every"]), "--eval-pairs", str(x["trained_eval_pairs"]), "--hidden", hidden,
            "--seed-base", seed(cycle_id, "trained")[:2], "--max-hours", f"{hours:.3f}", *RECIPE]


def measure_cmd(x: dict, files: dict, A: str, T: str, T2: str, cycle_id: str, out: str | None = None) -> list[str]:
    return ["node", TRAINED_TS, "--stage", "measure", "--explorer", files["explorer"], "--start", files["start"], "--adaptive", A, "--twin", T, "--twin2", T2,
            "--run", files["run"], "--trained-against", files["against"], "--pairs", str(x["measure_pairs"]), "--check-pairs", str(x["check_pairs"]),
            "--style-matches", str(x["style_matches"]), "--threads", str(x["threads"]), "--seed", seed(cycle_id, "measure"), "--style-seed", seed(cycle_id, "style"),
            *(["--out", out] if out else [])]


def control_cmd(x: dict, files: dict, explorer: str, A: str, T: str, T2: str, cycle_id: str) -> list[str]:
    """The control explorer against A next to a trained explorer (run-feints.sh earlier_trained); writes <run of A>/eval/explorer-control.json."""
    return ["node", TRAINED_TS, "--stage", "control", "--control", files["explorer"], "--explorer", explorer, "--adaptive", A, "--twin", T, "--twin2", T2,
            "--run", files["run"], "--pairs", str(x["measure_pairs"]), "--threads", str(x["threads"]), "--seed", seed(cycle_id, "control")]


def facts_cmd(A: str) -> list[str]:
    return ["node", TRAINED_TS, "--stage", "facts", "--adaptive", A, "--words", "auto"]


def remeasure_spec(entry: dict, fresh_seed: str, candidate_sha: str | None = None) -> dict:
    """A search file for explorer.ts --remeasure holding one recorded explorer: its spec, and the
    file it was measured against last (failed against, if it ever failed) as the file searched,
    another file than the candidate's when the record has one (explorer.ts refuses a re-measure
    against the file searched)."""
    items = entry.get("failed") or entry.get("measured") or [{}]
    last = next((i for i in reversed(items) if i.get("sha256") != candidate_sha), items[-1])
    return {
        "stage": "record",
        "recordOf": {"id": entry["id"], "failed": entry.get("failed") or [], "measured": entry.get("measured") or []},
        "chosen": entry["spec"],
        "chosenLabel": entry["explorer"],
        "chosenInTraining": False,
        "bestOutside": None,
        "selectionGain": None,
        "rounds": [],
        "gridSize": 1,
        "gridSearched": 1,
        "seed": fresh_seed,
        "adapt": last.get("adapt"),
        "baseline": "ablated",
        "pool": "grid",
        "provenance": {"models": {"adaptive": {"sha256": last.get("sha256")}}},
    }


# The step -------------------------------------------------------------------------------------------


def blocked(cyc: Cycle, work: Path) -> str | None:
    """Why the step does not run for a candidate that can read, or None."""
    x = getattr(cyc.cfg, "explorer", None) or {}
    if cyc.cfg.gate.get("stats") != "live":
        return 'Not run: [gate] stats is not "live", and the explorer step runs only with the statistics live. A file that can read is promoted only through it.'
    if x.get("on") is not True:
        return "Not run: the config turns the explorer step off ([explorer] on is not true)."
    g = work / "gate" / "result.json"
    if not g.exists():
        raise CycleError("the explorer step needs this cycle's gate result: run the gate first")
    passed = bool(read_json(g)["pass"])
    forced = work / "gate" / "forced.json"
    if forced.exists() and cyc.cfg.mode == "minio":
        passed = read_json(forced)["force"] == "pass"
    return None if passed else "Not run: the gate rejected the candidate."


def folder(cyc: Cycle, cycle_id: str) -> Path:
    """data/<profile>/explorer/<cycleId>/: one numbered folder per attempt of the step in that cycle."""
    return cyc.cfg.data_dir / "explorer" / cycle_id


def next_attempt(cyc: Cycle, cycle_id: str) -> Path:
    d = folder(cyc, cycle_id)
    done = [int(p.name) for p in d.iterdir() if p.is_dir() and p.name.isdigit()] if d.is_dir() else []
    return d / str(max(done, default=0) + 1)


class Runner:
    """Runs the step's subprocesses with the cycle's log, deadline and heartbeat, timing each part."""

    def __init__(self, cyc: Cycle, work: Path, log_path: Path, heartbeat, deadline: float | None):
        self.cyc, self.log_path, self.heartbeat, self.deadline = cyc, log_path, heartbeat, deadline
        self.env = {"ZAP_FACTS": str(work / "facts-scratch.json")}
        self.seconds: dict[str, float] = {}

    def __call__(self, part: str, cmd: list[str]) -> str:
        t0 = time.time()
        try:
            return proc.run(cmd, self.log_path, env=self.env, deadline=self.deadline, heartbeat=self.heartbeat)
        finally:
            self.seconds[part] = round(self.seconds.get(part, 0.0) + time.time() - t0, 1)

    def hours_left(self) -> float | None:
        return None if self.deadline is None else (self.deadline - time.time()) / 3600


def _remeasure(run: Runner, x: dict, todo: list[dict], A: str, T: str, T2: str, eval_dir: Path, cycle_id: str, first_attempt: int, trained_explorer: str | None = None, candidate_sha: str | None = None) -> tuple[list[str], list[str]]:
    """Measures every recorded explorer in todo again against A. Returns the labels measured and the
    reasons of those that could not be (no spec, missing files). A control needs a trained explorer
    to stand next to (the PPO explorer of the step, or the newest trained one on record)."""
    done, skipped = [], []
    attempt = first_attempt
    rec_dir = eval_dir.parent / "records"
    control_done = False
    for i, e in enumerate(todo):
        if e["kind"] == "scripted":
            if not e.get("spec"):
                skipped.append(f"{e['explorer']}: on record without an explorer spec, so it cannot be measured again")
                continue
            spec_file = rec_dir / f"record-{i + 1}.json"
            write_json(spec_file, remeasure_spec(e, seed(cycle_id, "fresh"), candidate_sha))
            run("remeasure", fresh_cmd(x, A, T, cycle_id, attempt, rel(spec_file), rel(eval_dir / f"explorer-fresh-{attempt}.json"), remeasure=True))
            attempt += 1
        elif e["kind"] == "control":
            files = e.get("files") or {}
            missing = [files.get(k) or k for k in ("explorer", "run") if not files.get(k) or not _abs(files[k]).exists()]
            if missing:
                skipped.append(f"{e['explorer']}: the files to measure this control explorer again are missing ({', '.join(missing)})")
                continue
            if not trained_explorer or not _abs(trained_explorer).exists():
                skipped.append(f"{e['explorer']}: no trained explorer on this machine to measure the control next to")
                continue
            if control_done:
                skipped.append(f"{e['explorer']}: the criterion counts one control explorer, and another was measured")
                continue
            run("control", control_cmd(x, files, trained_explorer, A, T, T2, cycle_id))
            control_done = True
        else:
            files = e.get("files") or {}
            missing = [files.get(k) or k for k in ("explorer", "start", "run", "against") if not files.get(k) or not _abs(files[k]).exists()]
            if missing:
                skipped.append(f"{e['explorer']}: the files to measure this {e['kind']} explorer again are missing ({', '.join(missing)})")
                continue
            run("remeasure", measure_cmd(x, files, A, T, T2, cycle_id, rel(eval_dir / "history" / f"recorded-{i + 1}.json")))
        done.append(e["explorer"])
    return done, skipped


def _newest_trained(record: list[dict]) -> str | None:
    """The trained explorer on record measured last whose file is on this machine."""
    cands = [e for e in record if e["kind"] == "trained" and (e.get("files") or {}).get("explorer") and _abs(e["files"]["explorer"]).exists()]
    return max(cands, key=lambda e: e.get("lastMeasuredAt") or e.get("lastFailedAt") or 0)["files"]["explorer"] if cands else None


def _full(run: Runner, cyc: Cycle, x: dict, X: Path, A: str, T: str, T2: str, cycle_id: str, record: list[dict], header: dict, work: Path, res: dict) -> tuple[list[str], list[str], dict]:
    """Steps 1 to 6 against A. Returns the re-measured labels, the reasons of those left out, and the criterion of explorer-trained.ts."""
    from .train import priors_path

    ev = X / "eval"
    search = ev / "explorer-search-1.json"
    run("search", search_cmd(x, A, T, cycle_id, rel(search)))
    run("fresh", fresh_cmd(x, A, T, cycle_id, 1, rel(search), rel(ev / "explorer-fresh-1.json")))
    scripted = [e for e in record if e["kind"] == "scripted"]
    trained = [e for e in record if e["kind"] == "trained"]
    controls = [e for e in record if e["kind"] == "control"]
    done, skipped = _remeasure(run, x, scripted, A, T, T2, ev, cycle_id, 2, candidate_sha=res["candidate"]["sha256"])
    priors = priors_path(cyc, header, work)
    if priors is None:
        raise CycleError("a file that can read has features v2, so it needs its priors")
    init = X / "explorer-init" / "init-actor.pt"
    run("trainedInit", init_cmd(T, priors, rel(init)))
    hours = float(x["trained_hours"])
    left = run.hours_left()
    if left is not None and left - AFTER_TRAINING_H < hours:
        raise CycleError(f"time limit: the PPO explorer needs room for its whole cap of {hours:g} hours ([explorer] trained_hours) and {max(left, 0.0):.2f} hours are left "
                         f"before the cycle's deadline, {AFTER_TRAINING_H:g} of them kept for its measure: the step fails rather than train a shorter explorer")
    xr = X / "explorer-run"
    hidden = ",".join(str(h) for h in zapw_header(_abs(T))["hidden"])
    run("trainedTraining", ppo_cmd(x, rel(xr), A, priors, rel(init), hidden, cycle_id, hours))
    res["ppo"] = {"iterations": metric_lines(xr), "wanted": int(x["trained_iters"]), "run": rel(xr)}
    shutil.copy(xr / "current.zapw", xr / "explorer.zapw")
    files = {"explorer": rel(xr / "explorer.zapw"), "start": rel(init.parent / "start.zapw"), "run": rel(xr), "against": A}
    run("trainedMeasure", measure_cmd(x, files, A, T, T2, cycle_id))
    d2, s2 = _remeasure(run, x, trained, A, T, T2, ev, cycle_id, 0)
    d3, s3 = _remeasure(run, x, controls, A, T, T2, ev, cycle_id, 0, trained_explorer=files["explorer"])
    run("criterion", facts_cmd(A))
    crit = read_json(ev / "explorer-trained.json")["facts"]["explorer.criterion"]
    return done + d2 + d3, skipped + s2 + s3, crit


def cleanup(X: Path) -> None:
    """What the measures do not read again: the PPO explorer's checkpoint, batches, league and
    current file, and its starting actor (the start file and metrics.jsonl stay)."""
    xr = X / "explorer-run"
    for p in (xr / "checkpoint.pt", xr / "current.zapw", X / "explorer-init" / "init-actor.pt"):
        p.unlink(missing_ok=True)
    for d in (xr / "batches", xr / "league"):
        shutil.rmtree(d, ignore_errors=True)


def settings(cyc: Cycle) -> dict:
    x = dict(getattr(cyc.cfg, "explorer", None) or {})
    return {k: x[k] for k in sorted(x)}


def _record_verdicts(cyc: Cycle, verdicts: list[dict], record: list[dict], sha: str, net: str, adapt: Any, cycle_id: str, now: int, ppo_files: dict | None) -> list[str]:
    """Every verdict measured now joins state.explorerMeasured, and every failing one
    state.explorerFailures, with the spec or files a later measure needs. Returns the explorers that
    failed."""
    by_label = {e["explorer"]: e for e in record}
    new_failures = []
    for v in verdicts:
        if v.get("reused"):
            continue
        files = (by_label.get(v["explorer"]) or {}).get("files")
        if v["kind"] == "trained" and files is None and ppo_files and v["explorer"] == ppo_files["explorer"]:
            files = ppo_files
        item = {"sha256": sha, "network": net, "adapt": adapt, "upper95": v["adaptationPart"]["upper95"], "at": now, "source": f"cycle {cycle_id}"}
        spec = v.get("spec") or (by_label.get(v["explorer"]) or {}).get("spec")
        record_measured(cyc.state, v["kind"], v["explorer"], item, spec, files)
        if not v.get("pass"):
            record_failure(cyc.state, v["kind"], v["explorer"], item, spec, files)
            new_failures.append(v["explorer"])
    cyc.state.save()
    return new_failures


def run_explorer(cyc: Cycle, cycle_id: str, log_path: Path, heartbeat=None, deadline: float | None = None, on_start: Callable[[], None] | None = None, facts_path: Path | None = None, lift: str | None = None) -> dict | None:
    """The step for this cycle's candidate. None when its file cannot read; otherwise the result,
    also written to work/<cycle>/gate/explorer.json. lift: the owner's reason to measure a network
    that failed before (LIFT_FLAG); without it such a network is refused without a measure."""
    work = cyc.work(cycle_id)
    t0 = time.time()
    train = read_json(work / "train.json")
    cand = _abs(train["export"]["file"])
    out = work / "gate" / "explorer.json"
    header = zapw_header(cand)
    if not can_read(header):
        out.unlink(missing_ok=True)
        return None
    x = dict(getattr(cyc.cfg, "explorer", None) or {})
    sha, net = sha256_file(cand), network_hash(cand)
    limit = min(float(x.get("limit", LIMIT_MAX)), LIMIT_MAX)
    seed_record(cyc, facts_path)
    record = on_record(cyc)
    final = failed_against(cyc, sha, net)
    lift = plain(lift or "", 300) or None
    lifted = {"by": "owner", "reason": lift[:300], "at": cyc.clock(), "network": net, "failedIn": sorted({str(h.get("source")) for h in final})[:20]} if lift and final else None
    res: dict = {
        "cycleId": cycle_id,
        "candidate": {"version": train["version"], "file": rel(cand), "sha256": sha, "network": net, "adapt": (header.get("meta") or {}).get("adapt")},
        "applies": True,
        "ran": False,
        "source": "none",
        "reusedFrom": None,
        "limit": limit,
        "verdicts": [],
        "failuresOnRecord": [e["explorer"] for e in record if e["failedOnRecord"]],
        "measuredOnRecord": [e["explorer"] for e in record if not e["failedOnRecord"]],
        "remeasured": [],
        "pending": [],
        "newFailures": [],
        "criterion": None,
        "notes": [] if not lift or lifted else [f"{LIFT_FLAG} given, but this network has no failure on record: nothing to lift."],
        "settings": settings(cyc),
        "ppo": None,
        "lifted": lifted,
        "attempt": None,
        "seconds": {},
        "dir": None,
        "verdictFile": None,
    }
    why = blocked(cyc, work)
    if why is None and final and lifted is None:
        why = final_why(final)
    if why:
        res.update(pending=[e["explorer"] for e in record], reasons=[why], **{"pass": False})
        _remember(cyc, cycle_id, train["version"], net, sha, False, "none", cyc.clock())
        write_json(out, res)
        return res
    if on_start:
        on_start()
    out.unlink(missing_ok=True)
    X = next_attempt(cyc, cycle_id)
    (X / "eval").mkdir(parents=True)
    (X / "export").mkdir()
    A_path = X / "export" / cand.name
    shutil.copy(cand, A_path)
    args_file = train.get("argsFile")
    if args_file and _abs(args_file).exists():
        shutil.copy(_abs(args_file), X / "args.json")
    A, T, T2 = rel(A_path), str(x["twin"]), str(x["twin2"])
    for p in (T, T2):
        if not _abs(p).exists():
            raise CycleError(f"[explorer] twin file {p} is missing")
    run = Runner(cyc, work, log_path, heartbeat, deadline)
    # With the owner's lift the network is measured in full: an earlier passing verdict for it is not reused.
    reuse, notes = (None, []) if lifted else find_reusable(cyc, net, facts_path)
    res.update(ran=True, dir=rel(X), attempt=int(X.name), notes=res["notes"] + notes, trainingFamilyFrom=rel(_abs(args_file)) if args_file and (X / "args.json").exists() else None)
    skipped: list[str] = []
    ppo_files = {"explorer": rel(X / "explorer-run" / "explorer.zapw"), "start": rel(X / "explorer-init" / "start.zapw"), "run": rel(X / "explorer-run"), "against": A}
    try:
        if reuse is not None:
            labels = {v["explorer"] for v in reuse["verdicts"]}
            todo = [e for e in record if e["explorer"] not in labels or (e.get("lastFailedAt") or 0) > reuse["at"]]
            done, skipped = _remeasure(run, x, [e for e in todo if e["kind"] == "scripted"], A, T, T2, X / "eval", cycle_id, 1, candidate_sha=sha)
            d2, s2 = _remeasure(run, x, [e for e in todo if e["kind"] == "trained"], A, T, T2, X / "eval", cycle_id, 0)
            d3, s3 = _remeasure(run, x, [e for e in todo if e["kind"] == "control"], A, T, T2, X / "eval", cycle_id, 0, trained_explorer=_newest_trained(record))
            done, skipped = done + d2 + d3, skipped + s2 + s3
            new = [v for v in read_results(eval_files(X / "eval")) if v["sha256"] == sha]
            verdicts = [{**v, "reused": True} for v in reuse["verdicts"]] + [{**v, "reused": False} for v in new]
            res.update(source="reused", reusedFrom={"source": reuse["source"], "cycleId": reuse.get("cycleId"), "at": reuse["at"], "network": reuse["network"], "models": reuse["models"], "files": reuse["files"]})
        else:
            done, skipped, crit = _full(run, cyc, x, X, A, T, T2, cycle_id, record, header, work, res)
            verdicts = [{**v, "reused": False} for v in read_results(eval_files(X / "eval")) if v["sha256"] == sha]
            if crit.get("servedModel", {}).get("sha256") != sha:
                raise CycleError("the criterion of explorer-trained.ts judges another file")
            if sorted(_key(v) for v in ts_verdicts(crit)) != sorted(_key(v) for v in verdicts):
                raise CycleError("the criterion of explorer-trained.ts and the result files disagree on the verdicts")
            res.update(source="measured", criterion={"pass": crit.get("pass"), "pendingRemeasure": crit.get("pendingRemeasure"), "verdicts": len(ts_verdicts(crit)), "requirement": crit.get("requirement"), "file": rel(X / "eval" / "explorer-trained.json")})
    except BaseException as e:
        # A step that stops early (time limit, a crash, a disagreement) keeps what it measured: every
        # explorer that already failed against this file joins the record, so a later attempt of the
        # same network is refused instead of measured until it passes.
        _stopped(cyc, res, X, sha, net, limit, record, cycle_id, ppo_files, e)
        res["seconds"] = {**run.seconds, "total": round(time.time() - t0, 1)}
        cleanup(X)
        write_json(out, res)
        raise
    cleanup(X)
    res["seconds"] = {**run.seconds, "total": round(time.time() - t0, 1)}
    for v in verdicts:
        v["pass"] = v["adaptationPart"]["upper95"] <= limit
    labels = {v["explorer"] for v in verdicts}
    pending = [e["explorer"] for e in record if e["explorer"] not in labels]
    ppo = res.get("ppo")
    short = bool(ppo) and ppo["iterations"] < ppo["wanted"]
    passed = bool(verdicts) and all(v["pass"] for v in verdicts) and not pending and not short
    reasons = []
    for v in verdicts:
        if not v["pass"]:
            p = v["adaptationPart"]
            reasons.append(f"{v['explorer']} ({v['kind']}{', reused' if v.get('reused') else ''}): adaptation part {pts(p['mean'])} points, one-sided 95% upper bound {pts(p['upper95'])}, above the limit of {pts(limit)}.")
    for label in pending:
        why_skip = next((s for s in skipped if s.startswith(label + ":")), None)
        reasons.append(why_skip or f"{label}: on record, and not measured against this file.")
    if short:
        reasons.append(f"The PPO explorer reached {ppo['iterations']} of its {ppo['wanted']} iterations ([explorer] trained_iters) before its cap of {float(x['trained_hours']):g} hours: a shorter explorer is a weaker one, so this step cannot pass.")
    if not verdicts:
        reasons.append("No explorer was measured against this file.")
    now = cyc.clock()
    res.update(verdicts=verdicts, remeasured=done, pending=pending, reasons=reasons, **{"pass": passed})
    # Every explorer measured now joins the record for the next candidates; those that failed are final for this network.
    res["newFailures"] = _record_verdicts(cyc, verdicts, record, sha, net, res["candidate"]["adapt"], cycle_id, now, ppo_files)
    if passed:
        models = [{"path": A, "sha256": sha, "adapt": res["candidate"]["adapt"]}] + ((res["reusedFrom"] or {}).get("models") or [])
        files = sorted({v["file"] for v in verdicts})
        stored = {"source": f"cycle {cycle_id}", "cycleId": cycle_id, "at": now, "network": net, "models": models, "files": files, "limit": limit,
                  "verdicts": [{k: v[k] for k in ("explorer", "kind", "file", "sha256", "adaptationPart", "pass")} for v in verdicts], "pass": True}
        p = verdicts_dir(cyc) / f"{net}.json"
        write_json(p, stored)
        res["verdictFile"] = rel(p)
    _remember(cyc, cycle_id, train["version"], net, sha, passed, res["source"], now)
    write_json(out, res)
    return res


def _stopped(cyc: Cycle, res: dict, X: Path, sha: str, net: str, limit: float, record: list[dict], cycle_id: str, ppo_files: dict, err: BaseException) -> None:
    try:
        verdicts = [{**v, "reused": False} for v in read_results(eval_files(X / "eval")) if v["sha256"] == sha]
    except (OSError, KeyError, TypeError, ValueError):
        verdicts = []
    for v in verdicts:
        v["pass"] = v["adaptationPart"]["upper95"] <= limit
    now = cyc.clock()
    res.update(verdicts=verdicts, reasons=[f"The explorer step stopped before its end: {str(err)[:300] or type(err).__name__}."], **{"pass": False})
    res["newFailures"] = _record_verdicts(cyc, verdicts, record, sha, net, res["candidate"]["adapt"], cycle_id, now, ppo_files)
    _remember(cyc, cycle_id, res["candidate"]["version"], net, sha, False, "none", now)


def _remember(cyc: Cycle, cycle_id: str, version: str, net: str, sha: str, passed: bool, source: str, at: int) -> None:
    """state.explorerVerdicts: the step of every candidate that can read (one entry per cycle, the newest 200)."""
    rows = [r for r in cyc.state.get("explorerVerdicts") or [] if r.get("cycleId") != cycle_id]
    cyc.state["explorerVerdicts"] = (rows + [{"cycleId": cycle_id, "version": version, "network": net, "sha256": sha, "pass": passed, "source": source, "at": at}])[-200:]
    cyc.state.save()


# The guard and the card ---------------------------------------------------------------------------


def promotable(cyc: Cycle, work: Path, train: dict) -> dict:
    """Whether a candidate may be promoted as far as the explorer test goes. A file that cannot read
    passes. A file that can read needs this cycle's step result for that very file (SHA-256 and
    network), passing, every verdict read again from its result file with its upper bound at most
    the limit (never above LIMIT_MAX), every reused verdict's model file on disk with the same
    network, a verdict for every explorer on record, a PPO explorer that reached its iterations,
    in profile prod the sizes of the run that passed, and no failure on record against this network
    unless the owner lifted it for this step. 'guard' is true when the refusal is not a measured
    failure of the step (no result, the step off or blocked, a final failure, files gone, a record
    left, a short explorer, small sizes)."""
    cand = _abs(train["export"]["file"])
    header = zapw_header(cand)
    if not can_read(header):
        return {"applies": False, "ok": True, "guard": False, "result": None, "why": ""}
    sha, net = sha256_file(cand), network_hash(cand)
    p = work / "gate" / "explorer.json"
    res = read_json(p) if p.exists() else None
    problems: list[str] = []
    if res is None:
        problems.append("the explorer step left no result for this candidate")
    elif res.get("candidate", {}).get("sha256") != sha or res.get("candidate", {}).get("network") != net:
        problems.append("its explorer result names another file")
    elif not res.get("ran"):
        problems += res.get("reasons") or ["the explorer step did not run"]
    else:
        ppo = res.get("ppo")
        if ppo:
            xr = _abs(ppo.get("run") or "")
            got = metric_lines(xr) if ppo.get("run") and xr.is_dir() else None
            if got is None:
                problems.append(f"the PPO explorer's run folder {ppo.get('run')} is missing")
            elif min(got, int(ppo.get("iterations", 0))) < int(ppo.get("wanted", 0)):
                problems.append(f"the PPO explorer reached {min(got, int(ppo.get('iterations', 0)))} of its {ppo.get('wanted')} iterations")
        elif res.get("source") == "measured":
            problems.append("the step measured this file without a PPO explorer")
        if cyc.cfg.profile == "prod" and res.get("source") == "measured":
            problems += [f"the step ran with smaller sizes than the run that passed: {s}" for s in explorer_size_problems(res.get("settings") or {})]
        if not problems and not res.get("pass"):
            return {"applies": True, "ok": False, "guard": False, "result": res, "why": " ".join(res.get("reasons") or ["Failed the explorer test."])}
    if res is not None and res.get("ran") and not problems:
        limit = min(float(res.get("limit", LIMIT_MAX)), LIMIT_MAX)
        models = {sha: {"path": rel(cand), "sha256": sha}}
        for m in ((res.get("reusedFrom") or {}).get("models") or []):
            mp = _abs(m["path"])
            if not mp.exists():
                problems.append(f"the reused verdict's model file {m['path']} is missing")
            elif sha256_file(mp) != m["sha256"] or network_hash(mp) != net:
                problems.append(f"the reused verdict's model file {m['path']} is not this network")
            else:
                models[m["sha256"]] = m
        files = sorted({v["file"] for v in res.get("verdicts") or []})
        missing = [f for f in files if not _abs(f).exists()]
        if missing:
            problems.append(f"result files are missing: {', '.join(missing)}")
        else:
            got = {(v["explorer"], v["file"], v["sha256"]): v for v in read_results(files) if v["sha256"] in models}
            if not res.get("verdicts"):
                problems.append("no explorer was measured against this network")
            for v in res.get("verdicts") or []:
                g = got.get((v["explorer"], v["file"], v["sha256"]))
                if g is None:
                    problems.append(f"{v['explorer']}: no verdict against this network in {v['file']}")
                elif g["adaptationPart"]["upper95"] > limit:
                    problems.append(f"{v['explorer']}: upper bound {pts(g['adaptationPart']['upper95'])} points, above the limit")
        labels = {v["explorer"] for v in res.get("verdicts") or []}
        for e in on_record(cyc):
            if e["explorer"] not in labels:
                problems.append(f"{e['explorer']}: on record, with no verdict against this network")
        hits = failed_against(cyc, sha, net)
        if hits and not lifted_ok(res, net):
            problems.append(final_why(hits))
    if problems:
        why = f"Refused by the explorer guard: the file can read the in-match statistics (features v2, safety net {json.dumps((header.get('meta') or {}).get('adapt'))}) and has no passing explorer verdict for its network ({net[:8]}): " + " ".join(s if s.endswith(".") else s + "." for s in problems)
        return {"applies": True, "ok": False, "guard": True, "result": res, "why": why}
    return {"applies": True, "ok": True, "guard": False, "result": res, "why": ""}


def _setting(v: Any) -> Any:
    return v if isinstance(v, (bool, int, float)) else str(v)[:200]


def card_block(check: dict, train: dict) -> dict | None:
    """card.explorer (zap-card/1): the verdicts that count, the record, the sizes and the PPO
    explorer's iterations the step ran with, the owner's lift, and why it failed."""
    if not check.get("applies"):
        return None
    res = check.get("result") or {}
    cand = _abs(train["export"]["file"])
    verdicts = [
        {"explorer": v["explorer"][:300], "kind": v["kind"], "sha256": v["sha256"], "mean": v["adaptationPart"]["mean"], "upper95": v["adaptationPart"]["upper95"], "pairs": v["adaptationPart"]["pairs"], "pass": bool(v.get("pass"))}
        for v in res.get("verdicts") or []
    ][:500]
    ok = bool(check.get("ok"))
    reasons = [] if ok else [r[:500] for r in ([check["why"]] if check.get("guard") else res.get("reasons") or [check.get("why") or "Failed the explorer test."])][:64]
    reused = res.get("reusedFrom")
    limit = float(res.get("limit", LIMIT_MAX))
    pending = list(res.get("pending") or [])
    record = list(res.get("failuresOnRecord") or [])
    others = list(res.get("measuredOnRecord") or [])
    if ok is False and not reasons:
        reasons = ["Failed the explorer test."]
    ppo = res.get("ppo")
    lift = res.get("lifted")
    return {
        "network": res.get("candidate", {}).get("network") or network_hash(cand),
        "sha256": res.get("candidate", {}).get("sha256") or sha256_file(cand),
        "pass": ok,
        "limit": limit,
        "source": res.get("source", "none") if res.get("ran") else "none",
        "reusedFrom": {"source": reused["source"][:200], "sha256": reused["models"][0]["sha256"], "at": int(reused["at"])} if reused and res.get("ran") else None,
        "verdicts": verdicts if res.get("ran") else [],
        "failuresOnRecord": [r[:500] for r in record][:500],
        "measuredOnRecord": [r[:500] for r in others][:500],
        "pending": [r[:500] for r in pending if r in record or r in others][:500],
        "reasons": reasons,
        "settings": {str(k)[:64]: _setting(v) for k, v in list((res.get("settings") or {}).items())[:40]},
        "ppo": {"iterations": int(ppo["iterations"]), "wanted": int(ppo["wanted"])} if ppo and res.get("ran") else None,
        "lifted": {"reason": str(lift["reason"])[:300], "at": int(lift["at"]), "failedIn": [str(s)[:200] for s in lift.get("failedIn") or []][:20]} if lift else None,
    }
