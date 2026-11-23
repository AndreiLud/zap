"""Checks that a model written by the learner (Python) gives the same outputs in the TypeScript
forward pass used by the site, in f32 and in int8, for features v1 (431 inputs) and v2 (461
inputs, priors in meta). The TypeScript side also builds the feature encoder from the header and
checks that its size equals the inputs. Run in the train container:

  docker compose --profile train run --rm -T train python training/tests/check_model_format.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
from learner import Actor, write_model  # noqa: E402

JS = """
import { readFileSync } from 'node:fs';
const m = await import('./ai/src/mlp.ts');
const f = await import('./ai/src/features.ts');
const [path, xs] = [process.argv[1], JSON.parse(readFileSync(process.argv[2], 'utf8'))];
const model = m.parseModel(readFileSync(path));
const enc = f.encoderFor(model.header);
if (enc.size !== model.header.inputs) throw new Error('encoder size differs from the inputs');
const out = xs.map((x) => { const r = m.forward(model, Float32Array.from(x)); return [...Array.from(r.logits), r.value[0]]; });
console.log(JSON.stringify({ features: model.header.features, size: enc.size, out }));
"""

PRIORS = {
    "version": 1,
    "alpha": 2,
    "segments": {
        seg: {"raise": 0.3, "run": 0.35, "accept": 0.55, "reraise": 0.1, "shown": 0.6, "cover": 0.05}
        for seg in ("paulista-2", "paulista-4", "mineiro-2", "mineiro-4")
    },
}


def main() -> None:
    for features, inputs, meta in (("v1", 431, None), ("v2", 461, {"priors": PRIORS, "iteration": 0})):
        torch.manual_seed(7)
        actor = Actor(inputs, [256, 256])
        xs = (np.random.RandomState(3).randint(0, 256, size=(20, inputs)) / 255.0).astype(np.float32)
        with torch.no_grad():
            lg, v = actor(torch.from_numpy(xs))
        ref = torch.cat([lg, v.unsqueeze(1)], dim=1).numpy()
        with tempfile.TemporaryDirectory(dir=ROOT / ".cache") as tmp:
            xp = Path(tmp) / "x.json"
            xp.write_text(json.dumps(xs.tolist()))
            for dtype, tol in [("f32", 1e-4), ("i8", 0.05)]:
                mp = Path(tmp) / f"m-{dtype}.zapw"
                write_model(actor, mp, dtype=dtype, meta=meta, features=features)
                out = subprocess.run(["node", "--input-type=module", "-e", JS, str(mp), str(xp)], cwd=ROOT, capture_output=True, text=True, check=True)
                r = json.loads(out.stdout)
                assert r["features"] == features and r["size"] == inputs
                js = np.array(r["out"])
                err = float(np.abs(js - ref).max())
                print(f"{features} {dtype}: max abs difference {err:.2e} (limit {tol})")
                assert err < tol, f"{features} {dtype} outputs differ"
    print("model format OK")


if __name__ == "__main__":
    main()
