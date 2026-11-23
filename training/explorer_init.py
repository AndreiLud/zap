"""Starting actor of the trained explorer (explorer test, project_docs/ai.md): the twin, with
features v2-self.

The twin (features v2-empty) always saw the no-evidence block in its 30 statistics inputs, so its
weights on them act as a bias that depends on the segment. The explorer reads live statistics
there (about itself, the next seat and the partner), so those weights are moved out of the way:
the first layer gets zero weights on the statistics, and their effect on the no-evidence block is
folded into the bias and the two segment inputs (input 0 is the mineiro bit, input 1 the four
players bit). The fold is exact for paulista 1 against 1, paulista 2 against 2 and mineiro 1
against 1; mineiro 2 against 2 keeps an interaction term, whose largest size is printed.

Usage (train container):
  python training/explorer_init.py --twin training/runs/m6-twin/export/zap-v2.zapw \
      --priors ai/models/opponent-priors.json --out training/runs/m6-explorer-init/init-actor.pt
Also writes start.zapw (f32, features v2-self, priors in meta) next to --out, for the checks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from learner import Actor, write_model  # noqa: E402
from train import ROOT, encoder_info  # noqa: E402
from warm_start import read_zapw  # noqa: E402

MINEIRO_INPUT = 0
FOUR_INPUT = 1


def explorer_actor(twin_path: Path, priors: str) -> tuple[Actor, dict, float]:
    header, tensors = read_zapw(twin_path)
    if header["features"] != "v2-empty":
        raise ValueError("the explorer starts from the twin (features v2-empty)")
    enc = encoder_info("v2-self", priors)
    info = enc["info"]
    so, ss = info["statsOffset"], info["statsSize"]
    actor = Actor(header["inputs"], header["hidden"])
    state = actor.state_dict()
    with torch.no_grad():
        for name in state:
            src = torch.from_numpy(tensors[name])
            if tuple(src.shape) != tuple(state[name].shape):
                raise ValueError(f"{name}: shape {tuple(src.shape)} does not match {tuple(state[name].shape)}")
            state[name] = src.clone()
        w = state["trunk.0.weight"].double()
        b = state["trunk.0.bias"].double()
        ws = w[:, so : so + ss]
        d = {seg: ws @ torch.tensor(info["empty"][seg], dtype=torch.float64) for seg in enc["segments"]}
        b = b + d["paulista-2"]
        w[:, MINEIRO_INPUT] += d["mineiro-2"] - d["paulista-2"]
        w[:, FOUR_INPUT] += d["paulista-4"] - d["paulista-2"]
        interaction = float((d["mineiro-4"] - d["mineiro-2"] - d["paulista-4"] + d["paulista-2"]).abs().max())
        w[:, so : so + ss] = 0
        state["trunk.0.weight"] = w.float()
        state["trunk.0.bias"] = b.float()
    actor.load_state_dict(state)
    return actor, enc, interaction


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--twin", default="training/runs/m6-twin/export/zap-v2.zapw")
    ap.add_argument("--priors", default="ai/models/opponent-priors.json")
    ap.add_argument("--out", default="training/runs/m6-explorer-init/init-actor.pt")
    args = ap.parse_args()
    actor, enc, interaction = explorer_actor(ROOT / args.twin, args.priors)
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(actor.state_dict(), out)
    meta = {
        "iteration": 0,
        "priors": enc["priors"],
        "priorsSha256": hashlib.sha256((ROOT / args.priors).read_bytes()).hexdigest(),
        "startFrom": args.twin,
        "startFromSha256": hashlib.sha256((ROOT / args.twin).read_bytes()).hexdigest(),
    }
    write_model(actor, out.parent / "start.zapw", meta=meta, features="v2-self")
    rel = lambda p: str(p.relative_to(ROOT))  # noqa: E731
    print(json.dumps({"actor": rel(out), "model": rel(out.parent / "start.zapw"), "startFrom": args.twin, "inputs": enc["info"]["size"], "mineiro4InteractionMaxAbs": interaction}))


if __name__ == "__main__":
    main()
