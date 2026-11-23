"""Checks the adaptation regularizer of the learner: exactly 0 when the statistics block already
reads no evidence (the twin), positive otherwise, and w(n) = nW / (nW + n).

  docker compose --profile train run --rm -T train python training/tests/check_adapt_reg.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
from learner import Learner, masked_logits, record_dtype  # noqa: E402

FEATURES, CRITIC, SO, SS = 461, 135, 431, 30


def records(n: int, live: bool, empty: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    rec = np.zeros(n, dtype=record_dtype(FEATURES, CRITIC, 20))
    rec["x"] = rng.randint(0, 256, size=(n, FEATURES))
    rec["x"][:, 0] = rng.randint(0, 2, size=n) * 255
    rec["x"][:, 1] = rng.randint(0, 2, size=n) * 255
    seg = 2 * (rec["x"][:, 0] > 127) + (rec["x"][:, 1] > 127)
    if not live:
        rec["x"][:, SO : SO + SS] = np.round(empty[seg] * 255)
    rec["mask"] = rng.randint(1, 1 << 15, size=n)
    rec["nev"] = rng.randint(0, 12, size=n)
    return rec


def main() -> None:
    torch.manual_seed(3)
    rng = np.random.RandomState(5)
    empty = (rng.randint(0, 256, size=(4, SS)) / 255.0).astype(np.float32)
    learner = Learner(FEATURES, CRITIC, hidden=[32, 16], stats_offset=SO, stats_size=SS, empty=torch.from_numpy(empty))
    learner.hyper.adapt_nw = 2.0
    with torch.no_grad():
        learner.actor.trunk[0].weight[:, SO:] = torch.randn(32, SS)
    for live in (False, True):
        rec = records(500, live, empty, rng)
        t = learner.tensors(rec)
        with torch.no_grad():
            logp = F.log_softmax(masked_logits(learner.actor(t["x"])[0], t["mask"]), dim=-1)
            kl = learner.adapt_kl(t["x"], t["seg"], t["mask"], logp)
        if live:
            assert float(kl.mean()) > 1e-3, "live statistics must give a positive term"
        else:
            assert float(kl.abs().max()) == 0.0, f"the term must be exactly 0 with the no-evidence block, got {float(kl.abs().max())}"
        print(f"statistics {'live' if live else 'empty'}: mean KL {float(kl.mean()):.3e}, max {float(kl.abs().max()):.3e}")
    n = torch.tensor([0.0, 1.0, 2.0, 4.0, 10.0])
    w = learner.adapt_weight(n)
    assert torch.allclose(w, 2.0 / (2.0 + n)), "w(n) differs from nW / (nW + n)"
    assert float(w[0]) == 1.0 and abs(float(w[2]) - 0.5) < 1e-7
    print("regularizer OK")


if __name__ == "__main__":
    main()
