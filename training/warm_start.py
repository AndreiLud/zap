"""Warm start of the adaptive network (features v2, 461 inputs) from v1 (431 inputs).

The v1 file is int8 with one scale per row; each matrix is dequantized as q * scale[row] in
float32. The first layer gets the v1 columns and zeros for the 30 statistics columns, so at
iteration 0 the v2 network plays exactly as v1 whatever the statistics say. The same file starts
the adaptive run and its twin (both have 461 inputs).

Usage (train container):
  python training/warm_start.py --v1 ai/models/bootstrap/zap-v1.zapw --priors ai/models/opponent-priors.json \
      --out training/runs/m6-init/init-actor.pt
Also writes warm-v2.zapw (f32, features v2, priors in meta) next to --out, for the checks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from learner import Actor, write_model  # noqa: E402
from train import ROOT, encoder_info  # noqa: E402

MAGIC = 0x5750415A


def read_zapw(path: Path) -> tuple[dict, dict[str, np.ndarray]]:
    """Header and float32 tensors of a ZAPW file (int8 matrices dequantized as q * scale per row)."""
    b = path.read_bytes()
    magic, version, hlen = struct.unpack_from("<III", b, 0)
    if magic != MAGIC or version != 1:
        raise ValueError(f"{path}: not a Zap model file")
    header = json.loads(b[12 : 12 + hlen].decode())
    start = 12 + hlen + (4 - hlen % 4) % 4
    out: dict[str, np.ndarray] = {}
    for t in header["tensors"]:
        shape = t["shape"]
        count = int(np.prod(shape))
        if t["dtype"] == "f32":
            out[t["name"]] = np.frombuffer(b, dtype="<f4", count=count, offset=start + t["offset"]).reshape(shape).copy()
        else:
            q = np.frombuffer(b, dtype=np.int8, count=count, offset=start + t["offset"]).reshape(shape).astype(np.float32)
            scale = np.frombuffer(b, dtype="<f4", count=shape[0], offset=start + t["scaleOffset"]).astype(np.float32)
            out[t["name"]] = (q * scale[:, None]).astype(np.float32)
    return header, out


def warm_actor(v1_path: Path, inputs: int) -> Actor:
    header, tensors = read_zapw(v1_path)
    if header["features"] != "v1":
        raise ValueError("the warm start reads a v1 model")
    actor = Actor(inputs, header["hidden"])
    state = actor.state_dict()
    with torch.no_grad():
        for name in state:
            src = torch.from_numpy(tensors[name])
            if name == "trunk.0.weight":
                w = torch.zeros_like(state[name])
                w[:, : src.shape[1]] = src
                state[name] = w
            else:
                if tuple(src.shape) != tuple(state[name].shape):
                    raise ValueError(f"{name}: shape {tuple(src.shape)} does not match {tuple(state[name].shape)}")
                state[name] = src.clone()
    actor.load_state_dict(state)
    return actor


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--v1", default="ai/models/bootstrap/zap-v1.zapw")
    ap.add_argument("--priors", default="ai/models/opponent-priors.json")
    ap.add_argument("--out", default="training/runs/m6-init/init-actor.pt")
    args = ap.parse_args()
    enc = encoder_info("v2", args.priors)
    actor = warm_actor(ROOT / args.v1, enc["info"]["size"])
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(actor.state_dict(), out)
    meta = {"iteration": 0, "priors": enc["priors"], "priorsSha256": hashlib.sha256((ROOT / args.priors).read_bytes()).hexdigest(), "warmStartFrom": args.v1}
    write_model(actor, out.parent / "warm-v2.zapw", meta=meta, features="v2")
    print(json.dumps({"actor": str(out), "model": str(out.parent / "warm-v2.zapw"), "inputs": enc["info"]["size"]}))


if __name__ == "__main__":
    main()
