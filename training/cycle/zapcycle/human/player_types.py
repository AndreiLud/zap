"""Player types (contract 1.10 and 3.11): a Gaussian mixture with diagonal covariances on each
person's reading numbers (posterior means under the fitted priors), for the people whose 8 numbers
are all shown. Each number enters as logit(value) - logit(population), the person's distance from
the population value at their own mix of rules segments: the numbers differ from about two to four
times between 1 against 1 and 2 against 2, so raw values would sort people by the tables they
choose, not by style. accept is left out of the clustering: run, accept and reraise split the same
answers (run + accept + reraise = 1), so run and accept move together (correlation about -0.95)
and a mixture with diagonal covariances would cut one population of a single style into types
along that line. 7 numbers enter. A type's center is published as a value at the people's average
reference, with accept as 1 - run - reraise, so the published shape keeps the 8 numbers.

The number of types k goes from 1 to `max_k` and is chosen by BIC, each fit the best of `restarts`
starts. The choice must be stable: over `refits` bootstrap refits, made with the same number of
starts, the adjusted Rand index between each refit's types and the full fit's types must average
above `min_ari`; otherwise one type is reported, which the data page states as "no distinct
types". Types are published only when each has at least 20 people. numpy only."""

from __future__ import annotations

import math

import numpy as np

from ..context import CycleContext
from .common import MIN_PEOPLE, READING_KEYS, layer, logit, people, section

DEFAULTS = {"max_k": 6, "refits": 50, "min_ari": 0.7, "restarts": 10, "seed": 7}
# run + accept + reraise = 1: accept adds nothing but a tilt the diagonal mixture cannot fit.
CLUSTER_KEYS = tuple(k for k in READING_KEYS if k != "accept")
CLUSTER_IDX = [READING_KEYS.index(k) for k in CLUSTER_KEYS]


def settings(ctx: CycleContext) -> dict:
    return {**DEFAULTS, **section(ctx, "player_types")}


def _logsumexp(a: np.ndarray) -> np.ndarray:
    m = a.max(axis=1, keepdims=True)
    return (m + np.log(np.exp(a - m).sum(axis=1, keepdims=True)))[:, 0]


def _log_prob(X: np.ndarray, mu: np.ndarray, var: np.ndarray, pi: np.ndarray) -> np.ndarray:
    d2 = ((X[:, None, :] - mu[None]) ** 2 / var[None]).sum(-1)
    return -0.5 * (d2 + np.log(2 * math.pi * var).sum(-1)[None]) + np.log(pi)[None]


class Mixture:
    def __init__(self, mu: np.ndarray, var: np.ndarray, pi: np.ndarray, loglik: float):
        self.mu, self.var, self.pi, self.loglik = mu, var, pi, loglik

    @property
    def k(self) -> int:
        return len(self.pi)

    def params(self) -> int:
        k, d = self.mu.shape
        return 2 * k * d + k - 1

    def bic(self, n: int) -> float:
        return -2 * self.loglik + self.params() * math.log(n)

    def labels(self, X: np.ndarray) -> np.ndarray:
        return _log_prob(X, self.mu, self.var, self.pi).argmax(axis=1)


def fit_once(X: np.ndarray, k: int, rng: np.random.Generator, iters: int = 300, reg: float = 1e-3) -> Mixture:
    n, d = X.shape
    centers = [X[rng.integers(n)]]
    for _ in range(1, k):
        d2 = np.min([((X - c) ** 2).sum(1) for c in centers], axis=0)
        p = d2 / d2.sum() if d2.sum() > 0 else np.full(n, 1 / n)
        centers.append(X[rng.choice(n, p=p)])
    mu = np.array(centers, dtype=np.float64)
    var = np.tile(X.var(axis=0) + reg, (k, 1))
    pi = np.full(k, 1 / k)
    prev = -np.inf
    total = prev
    for _ in range(iters):
        lp = _log_prob(X, mu, var, pi)
        ll = _logsumexp(lp)
        total = float(ll.sum())
        resp = np.exp(lp - ll[:, None])
        nk = resp.sum(axis=0) + 1e-10
        pi = nk / n
        mu = (resp.T @ X) / nk[:, None]
        var = np.maximum((resp.T @ (X * X)) / nk[:, None] - mu * mu, 0) + reg
        if total - prev < 1e-7 * abs(total):
            break
        prev = total
    return Mixture(mu, var, pi, float(_logsumexp(_log_prob(X, mu, var, pi)).sum()))


def fit(X: np.ndarray, k: int, rng: np.random.Generator, restarts: int = 3) -> Mixture:
    return max((fit_once(X, k, rng) for _ in range(max(1, restarts))), key=lambda m: m.loglik)


def ari(a: np.ndarray, b: np.ndarray) -> float:
    """Adjusted Rand index of two labelings (1 when both put everyone in one group)."""
    a = np.asarray(a)
    b = np.asarray(b)
    _, ai = np.unique(a, return_inverse=True)
    _, bi = np.unique(b, return_inverse=True)
    table = np.zeros((ai.max() + 1, bi.max() + 1))
    np.add.at(table, (ai, bi), 1)
    comb = lambda x: x * (x - 1) / 2  # noqa: E731
    s_ij = comb(table).sum()
    s_a = comb(table.sum(1)).sum()
    s_b = comb(table.sum(0)).sum()
    total = comb(len(a))
    expected = s_a * s_b / total if total else 0.0
    top = (s_a + s_b) / 2
    if top == expected:
        return 1.0
    return float((s_ij - expected) / (top - expected))


def choose(X: np.ndarray, s: dict) -> dict:
    """k by BIC, then its stability; an unstable choice falls back to one type."""
    rng = np.random.default_rng(int(s["seed"]))
    n = len(X)
    fits = {k: fit(X, k, rng, int(s["restarts"])) for k in range(1, int(s["max_k"]) + 1) if k <= n}
    bics = {k: m.bic(n) for k, m in fits.items()}
    best = min(bics, key=lambda k: bics[k])
    model = fits[best]
    stability = 1.0
    if best > 1:
        base = model.labels(X)
        scores = []
        for _ in range(int(s["refits"])):
            idx = rng.integers(0, n, n)
            refit = fit(X[idx], best, rng, int(s["restarts"]))
            scores.append(ari(base, refit.labels(X)))
        stability = float(np.mean(scores))
        if stability <= float(s["min_ari"]):
            return {"k": 1, "chosen": best, "stable": False, "ari": stability, "model": fits[1], "bic": bics}
    return {"k": best, "chosen": best, "stable": True, "ari": stability, "model": model, "bic": bics}


def _kept(readings: list[dict]) -> list[dict]:
    return [r for r in readings if r["shown"] and all(v is not None for v in r["values"])]


def _population(r: dict) -> list[float]:
    """The reading's population values (older reading files have none: no offset)."""
    return r.get("population") or [0.5] * len(READING_KEYS)


def matrix(readings: list[dict]) -> np.ndarray:
    """One row per person with all 8 numbers shown, the columns of CLUSTER_KEYS."""
    rows = []
    for r in _kept(readings):
        pop = _population(r)
        rows.append([logit(r["values"][i]) - logit(pop[i]) for i in CLUSTER_IDX])
    return np.array(rows, dtype=np.float64).reshape(-1, len(CLUSTER_KEYS))


def reference(readings: list[dict]) -> np.ndarray:
    """The mean logit of the population values over the people of matrix(): where centers are shown."""
    rows = [[logit(_population(r)[i]) for i in CLUSTER_IDX] for r in _kept(readings)]
    return np.array(rows, dtype=np.float64).reshape(-1, len(CLUSTER_KEYS)).mean(axis=0) if rows else np.zeros(len(CLUSTER_KEYS))


def summary_block(X: np.ndarray, res: dict, ref: np.ndarray | None = None) -> dict | None:
    """summary.playerTypes, or None when a type has fewer than 20 people."""
    m: Mixture = res["model"]
    labels = m.labels(X) if res["k"] > 1 else np.zeros(len(X), dtype=int)
    counts = np.bincount(labels, minlength=m.k)
    if (counts < MIN_PEOPLE).any():
        return None
    ref = np.zeros(len(CLUSTER_KEYS)) if ref is None else ref
    types = []
    for j in np.argsort(-counts):
        at = {key: round(1 / (1 + math.exp(-float(m.mu[j, i] + ref[i]))), 3) for i, key in enumerate(CLUSTER_KEYS)}
        at["accept"] = round(max(0.0, 1 - at["run"] - at["reraise"]), 3)
        center = {key: at[key] for key in READING_KEYS}
        types.append({"share": round(float(counts[j]) / len(X), 3), "center": center})
    return {"k": int(m.k), "ari": round(max(-1.0, min(1.0, res["ari"])), 3), "types": types}


def run_player_types(ctx: CycleContext, readings: list[dict]) -> tuple[dict, dict | None, dict]:
    need = int(ctx.config.thresholds["player_types_devices"])
    X = matrix(readings)
    n = len(X)
    if n < max(need, MIN_PEOPLE):
        why = f"Waits for {need} people whose 8 numbers are all shown."
        return layer(False, why, people=people(n), peopleNeeded=need), None, {"people": n}
    s = settings(ctx)
    res = choose(X, s)
    block = summary_block(X, res, reference(readings))
    report = {"people": n, "k": res["k"], "chosen": res["chosen"], "stable": res["stable"], "ari": res["ari"], "bic": {str(k): v for k, v in res["bic"].items()}}
    if res["k"] == 1:
        why = "No distinct types: one group fits the people best." if res["stable"] else "No distinct types: the groups found did not hold up when the people were resampled."
    else:
        why = f"{res['k']} types of player, stable when the people are resampled."
    if block is None:
        why += " Not shown: a type has fewer than 20 people."
    return layer(True, why, people=people(n), peopleNeeded=need), block, report
