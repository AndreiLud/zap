"""The twin without human data (contract 3.7, plan section 6): trained from the same start, with the
same seed and the same compute as the candidate, only without the human model in its league. A
second twin with the seed base plus 1 measures how much two runs differ by seed alone (the seed
noise floor). This module holds the parts of train.py that are about the twin."""

from __future__ import annotations

import sys
from pathlib import Path

from ..config import ROOT


def quantize(src: Path, dst: Path) -> Path:
    """dst: the int8 form of a training snapshot (learner.write_model, the same per row scale as
    ai/bench/export-model.ts), so the twin is compared in the form a served model has."""
    sys.dont_write_bytecode = True
    p = str(ROOT / "training")
    if p not in sys.path:
        sys.path.insert(0, p)
    import torch
    from learner import Actor, write_model  # noqa: PLC0415
    from warm_start import read_zapw  # noqa: PLC0415

    header, tensors = read_zapw(Path(src))
    actor = Actor(header["inputs"], list(header["hidden"]))
    state = actor.state_dict()
    for name in state:
        state[name] = torch.from_numpy(tensors[name]).clone()
    actor.load_state_dict(state)
    dst.parent.mkdir(parents=True, exist_ok=True)
    write_model(actor, dst, "i8", meta=header.get("meta"), features=header["features"])
    return dst


def same_compute(plan_iters: int, done: int) -> int:
    """Iterations for a twin: what the candidate really ran (a time limit may have cut it short)."""
    return max(1, min(int(plan_iters), int(done))) if done > 0 else int(plan_iters)
