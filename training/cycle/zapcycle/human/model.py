"""Human behaviour model (contract 3.11): predicts the next action of a person from what that person
sees, so that training can meet opponents who play like people.

Choice of model. The actor network of training/learner.py (features v1, the hidden sizes of the
self-play network), started from the self-play weights and fine tuned on people's decisions:
* it starts from what self-play already learned about the game, so a few hundred matches only
  have to move it towards how people play (the plan asks for exactly this start);
* it is written with learner.write_model as an ordinary ZAPW file, so the existing NetAgent plays
  it in the training league with no new code in the frozen engine and AI folders;
* it is small: 180,496 weights with the hidden sizes of v1; one epoch over 100,000 rows took
  6.7 s on one CPU core (measured on 2026-11-22).
An L2 pull towards the starting weights (`anchor`) and early stopping on people held out of the
training split keep it from fitting a few devices. The self-play network is far more certain than
people are, so after the fine tuning one temperature is fitted on the held out people and folded
into the policy layer (its weights and bias divided by it): the file stays a plain network.

Rows: node/human/features.ts writes the decisions with weight above 0 (no friends, unlinked or
flagged seats, automatic or forced moves), in the canonical action space of the network. Split:
80/20 by a hash of the group, so a person is either in training or in the test, never both. The
baseline: action frequencies per (decision type, legal mask) on the training split with add one
smoothing. The test: accuracy and log loss per decision type for both, and a 95% interval over
people of the model's log loss minus the baseline's, twice: on `bet` rows alone (the decisions the
seventh character is for) and on `bet` and `answer` rows together. It passes when both whole
intervals lie below 0; only then does it join training (the league kind 'human'). The interval is a
Student t interval over the people's own mean differences with k - 1 degrees of freedom, whatever
the number of test people k. A percentile bootstrap over people passed a model no better than the
baseline too often: about 5% of the time instead of 2.5% at 11 test people (the review's
simulation, the threshold of 50 devices), and from 2.75% to 8% at 30, 50 and 100 test people,
where the t interval stayed from 1.75% to 4.5% (the verification's simulation; the numbers of the
fixed rule are in project_docs/cycle.md)."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

import numpy as np

from ..config import ROOT
from ..context import CycleContext
from .common import DECISION_TYPES, dump, layer, node, people, records_dir, section, store, work, write_groups

NUM_FEATURES = 431
NUM_ACTIONS = 15
BUNDLED = ROOT / "ai/models/bootstrap/zap-v1.zapw"
MODEL_NAME = "human-model.zapw"
DEFAULTS = {
    "epochs": 12,
    "patience": 3,
    "batch": 512,
    "lr": 0.001,
    "anchor": 0.0001,
    "test_share": 0.2,
    "valid_share": 0.1,
    "max_rows": 300000,
    "seed": 11,
}


def settings(ctx: CycleContext) -> dict:
    return {**DEFAULTS, **section(ctx, "model")}


def _training_modules():
    """learner.py and warm_start.py of training/ (imported, never changed, no bytecode written)."""
    sys.dont_write_bytecode = True
    p = str(ROOT / "training")
    if p not in sys.path:
        sys.path.insert(0, p)
    import learner  # noqa: PLC0415
    import warm_start  # noqa: PLC0415

    return learner, warm_start


def share(group: str, salt: str) -> float:
    """A stable number in [0, 1) per group: the same person always lands on the same side."""
    return int(hashlib.sha256(f"{salt}:{group}".encode()).hexdigest()[:8], 16) / 2**32


def split(groups: list[str], test_share: float) -> np.ndarray:
    """True for rows of test groups."""
    return np.array([share(g, "human-test") < test_share for g in groups], dtype=bool)


def legal_bits(mask: np.ndarray) -> np.ndarray:
    return ((mask[:, None].astype(np.int64) >> np.arange(NUM_ACTIONS)) & 1).astype(bool)


def baseline_logp(types: list[str], mask: np.ndarray, y: np.ndarray, w: np.ndarray, train: np.ndarray) -> np.ndarray:
    """log p(y) of each row under the frequencies per (type, legal mask) of the training rows,
    weighted by w, plus one for every legal action."""
    keys = [f"{t}:{int(m)}" for t, m in zip(types, mask)]
    counts: dict[str, np.ndarray] = {}
    for k, a, wt, tr in zip(keys, y, w, train):
        if tr:
            c = counts.setdefault(k, np.zeros(NUM_ACTIONS))
            c[int(a)] += float(wt)
    legal = legal_bits(mask)
    out = np.empty(len(y))
    for r, k in enumerate(keys):
        c = counts.get(k, np.zeros(NUM_ACTIONS))
        num = c[int(y[r])] + 1.0
        den = c[legal[r]].sum() + legal[r].sum()
        out[r] = np.log(num / den)
    return out


def load_rows(d: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
    y = np.fromfile(d / "human-y.u8", dtype=np.uint8)
    mask = np.fromfile(d / "human-mask.u16", dtype="<u2")
    meta = [json.loads(line) for line in (d / "human-meta.jsonl").read_text().splitlines() if line.strip()]
    n = len(y)
    x = np.memmap(d / "human-x.f32", dtype="<f4", mode="r", shape=(n, NUM_FEATURES)) if n else np.zeros((0, NUM_FEATURES), np.float32)
    if not (len(mask) == len(meta) == n):
        raise ValueError("the human model rows do not line up")
    return x, y, mask, meta


def init_state(source: Path | None, hidden: list[int] | None = None):
    """An Actor of features v1 with the self-play weights of source (a v2 file gives its first 431
    input columns, the v1 part), or a fresh one with `hidden` when source is None."""
    learner, warm_start = _training_modules()
    import torch

    if source is None:
        return learner.Actor(NUM_FEATURES, list(hidden or [64])), "fresh"
    header, tensors = warm_start.read_zapw(source)
    actor = learner.Actor(NUM_FEATURES, list(header["hidden"]))
    state = actor.state_dict()
    with torch.no_grad():
        for name in state:
            src = torch.from_numpy(tensors[name])
            if name == "trunk.0.weight":
                src = src[:, :NUM_FEATURES]
            if tuple(src.shape) != tuple(state[name].shape):
                raise ValueError(f"{name}: shape {tuple(src.shape)} does not fit {tuple(state[name].shape)}")
            state[name] = src.clone()
    actor.load_state_dict(state)
    return actor, f"{source.name} ({header['features']})"


def _batches(idx: np.ndarray, size: int, rng: np.random.Generator | None):
    order = rng.permutation(idx) if rng is not None else idx
    for s in range(0, len(order), size):
        yield np.sort(order[s : s + size])


def _logp_all(actor, x, mask, idx: np.ndarray, size: int = 4096) -> np.ndarray:
    """log softmax over legal actions, rows idx, as a (len(idx), 15) array."""
    learner, _ = _training_modules()
    import torch

    out = np.empty((len(idx), NUM_ACTIONS), dtype=np.float64)
    actor.eval()
    with torch.no_grad():
        for s in range(0, len(idx), size):
            b = idx[s : s + size]
            logits, _ = actor(torch.from_numpy(np.ascontiguousarray(x[b])))
            lp = torch.log_softmax(learner.masked_logits(logits, torch.from_numpy(mask[b].astype(np.int64))), dim=-1)
            out[s : s + len(b)] = lp.numpy()
    return out


def fit(actor, x, y, mask, w, train_idx: np.ndarray, valid_idx: np.ndarray, s: dict, threads: int = 1):
    """Fine tunes actor on train_idx (loss weighted by w, L2 pull to the start), early stopping on
    valid_idx. Returns the best actor and the epochs run."""
    learner, _ = _training_modules()
    import torch

    torch.set_num_threads(max(1, int(threads)))
    torch.manual_seed(int(s["seed"]))
    rng = np.random.default_rng(int(s["seed"]))
    start = [p.detach().clone() for p in actor.parameters()]
    opt = torch.optim.Adam(actor.parameters(), lr=float(s["lr"]))
    anchor = float(s["anchor"])

    def valid_loss() -> float:
        if len(valid_idx) == 0:
            return 0.0
        lp = _logp_all(actor, x, mask, valid_idx)
        nll = -lp[np.arange(len(valid_idx)), y[valid_idx]]
        return float((nll * w[valid_idx]).sum() / max(w[valid_idx].sum(), 1e-12))

    best = valid_loss()
    best_state = {k: v.clone() for k, v in actor.state_dict().items()}
    stale = 0
    epochs = 0
    for _ in range(int(s["epochs"])):
        epochs += 1
        actor.train()
        for b in _batches(train_idx, batch_size(len(train_idx), int(s["batch"])), rng):
            xb = torch.from_numpy(np.ascontiguousarray(x[b]))
            mb = torch.from_numpy(mask[b].astype(np.int64))
            yb = torch.from_numpy(y[b].astype(np.int64))
            wb = torch.from_numpy(w[b].astype(np.float32))
            logits, _ = actor(xb)
            lp = torch.log_softmax(learner.masked_logits(logits, mb), dim=-1)
            loss = -(lp.gather(1, yb[:, None])[:, 0] * wb).sum() / wb.sum().clamp_min(1e-6)
            if anchor > 0:
                loss = loss + anchor * sum(((p - p0) ** 2).sum() for p, p0 in zip(actor.parameters(), start))
            opt.zero_grad()
            loss.backward()
            opt.step()
        v = valid_loss()
        if v < best - 1e-6 or len(valid_idx) == 0:
            best = v
            best_state = {k: t.clone() for k, t in actor.state_dict().items()}
            stale = 0
        else:
            stale += 1
            if stale >= int(s["patience"]):
                break
    actor.load_state_dict(best_state)
    return actor, epochs


def batch_size(n_train: int, batch: int) -> int:
    """The configured batch, smaller for small data so that an epoch still takes about 50 steps."""
    return int(max(32, min(batch, n_train // 50)))


TEMPERATURES = np.exp(np.linspace(np.log(0.25), np.log(16.0), 61))


def calibrate(actor, x, y, mask, w, idx: np.ndarray) -> float:
    """The temperature that minimizes the weighted log loss on rows idx, folded into the policy layer."""
    learner, _ = _training_modules()
    import torch

    if len(idx) == 0:
        return 1.0
    actor.eval()
    logits = []
    with torch.no_grad():
        for s in range(0, len(idx), 4096):
            b = idx[s : s + 4096]
            out, _ = actor(torch.from_numpy(np.ascontiguousarray(x[b])))
            logits.append(learner.masked_logits(out, torch.from_numpy(mask[b].astype(np.int64))))
    z = torch.cat(logits).double()
    yt = torch.from_numpy(y[idx].astype(np.int64))
    wt = torch.from_numpy(w[idx].astype(np.float64))
    best_t, best = 1.0, float("inf")
    for t in TEMPERATURES:
        lp = torch.log_softmax(z / float(t), dim=-1).gather(1, yt[:, None])[:, 0]
        loss = float(-(lp * wt).sum() / wt.sum().clamp_min(1e-12))
        if loss < best:
            best_t, best = float(t), loss
    with torch.no_grad():
        actor.policy.weight.div_(best_t)
        actor.policy.bias.div_(best_t)
    return best_t


# Student t, 0.975 quantile, by degrees of freedom (1 to 29).
T975 = (12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045)
Z975 = 1.959963984540054


def t975(df: int) -> float:
    """The 0.975 quantile of Student t: the table up to 29 degrees of freedom, then the Cornish
    Fisher expansion in 1 / df (Abramowitz and Stegun 26.7.5), within 0.0001 of the exact value
    from 30 on (2.0423 at 30, 1.9840 at 99)."""
    if df < 1:
        raise ValueError("t975 needs at least 1 degree of freedom")
    if df <= len(T975):
        return T975[df - 1]
    z = Z975
    g1 = (z**3 + z) / 4
    g2 = (5 * z**5 + 16 * z**3 + 3 * z) / 96
    g3 = (3 * z**7 + 19 * z**5 + 17 * z**3 - 15 * z) / 384
    return z + g1 / df + g2 / df**2 + g3 / df**3


def group_t_interval(values: np.ndarray, weights: np.ndarray, groups: list[str]) -> dict:
    """Each person's weighted mean of values, then the mean of those with a 95% Student t interval
    (k - 1 degrees of freedom)."""
    names = sorted(set(groups))
    pos = {g: i for i, g in enumerate(names)}
    gi = np.array([pos[g] for g in groups], dtype=np.int64)
    s = np.bincount(gi, weights=values * weights, minlength=len(names))
    n = np.bincount(gi, weights=weights, minlength=len(names))
    per = s[n > 0] / n[n > 0]
    k = len(per)
    if k == 0:
        return {"mean": None, "lo": None, "hi": None, "groups": 0}
    mean = float(per.mean())
    if k < 2:
        return {"mean": mean, "lo": None, "hi": None, "groups": k}
    se = float(per.std(ddof=1)) / float(np.sqrt(k))
    t = t975(k - 1)
    return {"mean": mean, "lo": mean - t * se, "hi": mean + t * se, "groups": k}


def interval(values: np.ndarray, weights: np.ndarray, groups: list[str], s: dict) -> dict:
    """The 95% interval over people of the module docstring, with the method it used."""
    return {**group_t_interval(values, weights, groups), "method": "student-t"}


def _metrics(lp_y: np.ndarray, correct: np.ndarray, w: np.ndarray) -> dict:
    tw = float(w.sum())
    if tw <= 0:
        return {"accuracy": None, "logLoss": None}
    return {"accuracy": round(float((correct * w).sum() / tw), 4), "logLoss": round(float((-lp_y * w).sum() / tw), 4)}


def fit_and_test(x, y, mask, meta: list[dict], actor, s: dict, threads: int = 1) -> tuple[object, dict]:
    """The whole method of the module docstring on rows already loaded. Returns the trained actor and
    its report (report['pass'] decides)."""
    groups = [m["group"] for m in meta]
    types = [m["type"] for m in meta]
    w = np.array([float(m["w"]) for m in meta], dtype=np.float64)
    test = split(groups, float(s["test_share"]))
    valid = np.array([not t and share(g, "human-valid") < float(s["valid_share"]) for g, t in zip(groups, test)], dtype=bool)
    train = ~test & ~valid
    train_idx, valid_idx, test_idx = np.flatnonzero(train), np.flatnonzero(valid), np.flatnonzero(test)
    report: dict = {
        "rows": {"train": int(len(train_idx)), "valid": int(len(valid_idx)), "test": int(len(test_idx))},
        "groups": {k: len({groups[i] for i in idx}) for k, idx in (("train", train_idx), ("valid", valid_idx), ("test", test_idx))},
    }
    base_lp = baseline_logp(types, mask, y, w, train)
    epochs = 0
    if len(train_idx):
        actor, epochs = fit(actor, x, y, mask, w, train_idx, valid_idx, s, threads)
    report["epochs"] = epochs
    # Calibrated on people held out of training (the training rows when there are none).
    report["temperature"] = round(calibrate(actor, x, y, mask, w, valid_idx if len(valid_idx) else train_idx), 4)
    if len(test_idx) == 0:
        report.update(types={}, betAnswer=None, passed=False, why="no test rows")
        return actor, report
    lp = _logp_all(actor, x, mask, test_idx)
    yt = y[test_idx]
    model_lp = lp[np.arange(len(test_idx)), yt]
    model_ok = lp.argmax(axis=1) == yt
    legal = legal_bits(mask[test_idx])
    # The baseline's choice: the most frequent legal action of the cell, from base_lp of each action.
    base_ok = np.empty(len(test_idx), dtype=bool)
    keys = [f"{types[i]}:{int(mask[i])}" for i in test_idx]
    best_of: dict[str, int] = {}
    tr_counts: dict[str, np.ndarray] = {}
    for i in train_idx:
        k = f"{types[i]}:{int(mask[i])}"
        tr_counts.setdefault(k, np.zeros(NUM_ACTIONS))[int(y[i])] += w[i]
    for r, k in enumerate(keys):
        if k not in best_of:
            c = tr_counts.get(k, np.zeros(NUM_ACTIONS)) + 1.0
            c[~legal[r]] = -1
            best_of[k] = int(np.argmax(c))
        base_ok[r] = best_of[k] == yt[r]
    tw = w[test_idx]
    ttypes = [types[i] for i in test_idx]
    per_type = {}
    for t in DECISION_TYPES:
        sel = np.array([tt == t for tt in ttypes])
        if not sel.any():
            continue
        per_type[t] = {"rows": int(sel.sum()), "model": _metrics(model_lp[sel], model_ok[sel], tw[sel]), "baseline": _metrics(base_lp[test_idx][sel], base_ok[sel], tw[sel])}
    report["types"] = per_type
    all_diff = (-model_lp) - (-base_lp[test_idx])

    def rule(sel: np.ndarray) -> dict | None:
        if not sel.any():
            return None
        iv = interval(all_diff[sel], tw[sel], [groups[i] for i, b in zip(test_idx, sel) if b], s)
        return {"rows": int(sel.sum()), "diff": iv["mean"], "lo": iv["lo"], "hi": iv["hi"], "groups": iv["groups"], "method": iv["method"]}

    def below(r: dict | None) -> bool:
        return r is not None and r["hi"] is not None and r["groups"] >= 2 and r["hi"] < 0

    report["bet"] = rule(np.array([tt == "bet" for tt in ttypes]))
    report["betAnswer"] = rule(np.array([tt in ("bet", "answer") for tt in ttypes]))
    if report["betAnswer"] is None:
        report.update(passed=False, why="no bet or answer rows in the test split")
        return actor, report
    passed = below(report["bet"]) and below(report["betAnswer"])
    report["passed"] = bool(passed)
    if passed:
        report["why"] = "the 95% intervals of the log loss difference on bet decisions, and on bet and answer decisions, lie below 0"
    elif not below(report["bet"]):
        report["why"] = "the model did not beat the frequency baseline on bet decisions with 95% confidence"
    else:
        report["why"] = "the model did not beat the frequency baseline on bet and answer decisions with 95% confidence"
    return actor, report


def init_source(ctx: CycleContext) -> Path:
    """The current version's local file (f32 snapshot when known), else the bundled v1."""
    try:
        man = ctx.models.get("manifest.json", 256 * 1024)
        cur = json.loads(man.body)["current"] if man is not None else None
    except Exception:  # an unreadable manifest only changes the starting weights
        cur = None
    if cur:
        d = ctx.data_dir / "versions" / cur
        for name in ("snapshot.zapw", "model.zapw"):
            if (d / name).exists():
                return d / name
    return BUNDLED


def run_human_model(ctx: CycleContext, exclude: set[str], summary: dict) -> tuple[dict, Path | None, dict | None, dict]:
    t = ctx.config.thresholds
    need_m, need_d = int(t["human_model_matches"]), int(t["human_model_devices"])
    vm, dev = int(summary.get("validMatches") or 0), int(summary.get("devices") or 0)
    progress = {"matches": vm, "matchesNeeded": need_m, "people": people(dev), "peopleNeeded": need_d}
    if vm < need_m or dev < need_d:
        return layer(False, f"Waits for {need_m} valid matches from at least {need_d} devices.", **progress), None, None, {"on": False}
    s = settings(ctx)
    d = work(ctx) / "model"
    ex = write_groups(work(ctx) / "exclude-groups.txt", exclude)
    feat = node(ctx, "features.ts", "--records", str(records_dir(ctx)), "--tables", str(ctx.tables_dir), "--out", str(d), "--exclude-groups", str(ex), "--max-rows", str(int(s["max_rows"])))
    x, y, mask, meta = load_rows(d)
    src = init_source(ctx)
    actor, init_name = init_state(src)
    actor, report = fit_and_test(x, y, mask, meta, actor, s, int(ctx.config.human.get("threads", 1)))
    learner, _ = _training_modules()
    out = d / MODEL_NAME
    learner.write_model(actor, out, "f32", meta={"note": "human behaviour model", "cycleId": ctx.cycle_id, "passed": report["passed"]}, features="v1")
    sha = hashlib.sha256(out.read_bytes()).hexdigest()
    report.update(sha256=sha, init=init_name, features=feat)
    dump(d / "report.json", report)
    card = {"sha256": sha, "pass": bool(report["passed"])}
    if report["passed"]:
        keep = store(ctx)
        shutil.copy(out, keep / MODEL_NAME)
        dump(keep / "report.json", report)
        why = "Beats the frequency baseline on bet decisions, and on bet and answer decisions together; joins the training league as an opponent."
        return layer(True, why, **progress), keep / MODEL_NAME, card, report
    return layer(False, "Trained, but it did not beat the frequency baseline on bet decisions and on bet and answer decisions together; it stays out of training.", **progress), None, card, report
