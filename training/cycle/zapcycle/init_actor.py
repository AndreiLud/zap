"""Actor state dict for the candidate's warm start (contract 3.7): the `actor` key of a training
checkpoint, or the weights of a ZAPW file dequantized with read_zapw of training/warm_start.py.

Run as a module so that `train` resolves to training/train.py:
  PYTHONPATH=training/cycle python -m zapcycle.init_actor (--checkpoint FILE | --zapw FILE) --out init-actor.pt
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "training"))


def from_zapw(path: Path) -> tuple[dict, dict]:
    import torch
    from learner import Actor  # training/learner.py, imported, never changed
    from warm_start import read_zapw  # training/warm_start.py, imported, never changed

    header, tensors = read_zapw(path)
    actor = Actor(header["inputs"], header["hidden"])
    state = actor.state_dict()
    for name in state:
        if name not in tensors:
            raise ValueError(f"{path}: tensor {name} missing")
        src = torch.from_numpy(tensors[name])
        if tuple(src.shape) != tuple(state[name].shape):
            raise ValueError(f"{name}: shape {tuple(src.shape)} does not match {tuple(state[name].shape)}")
        state[name] = src.clone()
    actor.load_state_dict(state)
    return actor.state_dict(), {"inputs": header["inputs"], "hidden": header["hidden"], "features": header["features"]}


def from_checkpoint(path: Path) -> dict:
    import torch

    ck = torch.load(path, weights_only=True, map_location="cpu")
    return ck["actor"]


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--checkpoint")
    g.add_argument("--zapw")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    import torch

    torch.set_num_threads(1)
    if args.checkpoint:
        state, info = from_checkpoint(Path(args.checkpoint)), {"source": "checkpoint"}
    else:
        state, info = from_zapw(Path(args.zapw))
        info["source"] = "zapw"
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(state, out)
    print(json.dumps({"out": str(out), **info}))


if __name__ == "__main__":
    main()
