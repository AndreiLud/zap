"""Checks the returns and advantages of the learner on hand episodes and match episodes.

Hand episodes (the default of selfplay.ts): the reward comes only at the last decision, so every
decision's Monte Carlo return is the hand's reward. Match episodes (--episode match, the trained
explorer): every hand's reward sits on the seat's latest decision and only the match end closes
the episode, so a decision's return is the reward still to come. Episode ids restart in every
self-play worker, so two episodes with the same id must stay apart at the done flag.

  docker compose --profile train run --rm -T train python training/tests/check_returns.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
from learner import FLAG_DONE, Learner, mc_returns, record_dtype  # noqa: E402


def recs(rows: list[tuple[int, float, bool]]) -> np.ndarray:
    rec = np.zeros(len(rows), dtype=record_dtype(4, 2, 20))
    for i, (ep, r, done) in enumerate(rows):
        rec["ep"][i] = ep
        rec["r"][i] = r
        rec["flags"][i] = FLAG_DONE if done else 0
    return rec


def main() -> None:
    # Hand episodes from two workers, both with episode ids 0 and 1, interleaved by concatenation.
    hand = recs([(0, 0, False), (0, 0.3, True), (1, -0.2, True), (0, 0, False), (0, 0, False), (0, -0.5, True), (1, 0.1, True)])
    got = mc_returns(hand)
    want = np.array([0.3, 0.3, -0.2, -0.5, -0.5, -0.5, 0.1], dtype=np.float32)
    assert np.allclose(got, want), f"hand episodes: {got} != {want}"

    # One match episode: rewards of three hands on the seat's latest decision, done at the end.
    match = recs([(7, 0, False), (7, 0.1, False), (7, 0, False), (7, -0.3, False), (7, 0.6, True), (8, 0.2, True)])
    got = mc_returns(match)
    want = np.array([0.4, 0.4, 0.3, 0.3, 0.6, 0.2], dtype=np.float32)
    assert np.allclose(got, want), f"match episodes: {got} != {want}"

    # GAE with a zero critic and lambda 1 is the Monte Carlo return; with lambda 0 it is the one step reward.
    learner = Learner(4, 2, hidden=[4])
    learner.hyper.gae_lambda = 1.0
    adv, ret = learner.advantages(match, np.zeros(len(match), dtype=np.float32))
    assert np.allclose(adv, mc_returns(match)) and np.allclose(ret, mc_returns(match)), adv
    learner.hyper.gae_lambda = 0.0
    adv, _ = learner.advantages(match, np.zeros(len(match), dtype=np.float32))
    assert np.allclose(adv, match["r"]), adv
    # A value at the next decision of the same episode is bootstrapped across hands.
    v = np.array([0, 0, 0.5, 0, 0, 0], dtype=np.float32)
    adv, _ = learner.advantages(match, v)
    assert np.isclose(adv[1], 0.1 + 0.5) and np.isclose(adv[2], -0.5), adv
    print("returns OK: hand episodes (ids repeated across workers), match episodes, GAE bootstrapping across hands")


if __name__ == "__main__":
    main()
