"""Checks that the warm start network plays exactly as v1 at iteration 0.

Writes the warm actor as f32 with features v2 (priors in meta), then runs Node
(training/tests/warm_start_check.ts): 100 matches per segment where every seat is v1 Zap with its
shipped knobs, and the same matches (same deal and policy seeds) with the warm network in the
same seats, the public match context passed. Identical action logs in all 400 matches; logits and
value head within 1e-4 on every visited state (v1 int8 on 431 inputs against v2 f32 on 461).
Repeats with features v2-empty, and with features v2 whose context carries a prior per seat far
from the population one (the profile hook of ai/src/opponent-stats.ts, off in the room): the
statistics inputs change, the play must not.

  docker compose --profile train run --rm -T train python training/tests/check_warm_start.py [--matches 100] [--write-facts]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
from learner import write_model  # noqa: E402
from train import encoder_info  # noqa: E402
from warm_start import warm_actor  # noqa: E402

import hashlib  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--v1", default="ai/models/bootstrap/zap-v1.zapw")
    ap.add_argument("--priors", default="ai/models/opponent-priors.json")
    ap.add_argument("--matches", type=int, default=100)
    ap.add_argument("--seed", default="75")
    ap.add_argument("--out", default="training/runs/m6-init/eval/warm-start.json")
    ap.add_argument("--write-facts", action="store_true")
    args = ap.parse_args()
    enc = encoder_info("v2", args.priors)
    actor = warm_actor(ROOT / args.v1, enc["info"]["size"])
    meta = {"iteration": 0, "priors": enc["priors"], "priorsSha256": hashlib.sha256((ROOT / args.priors).read_bytes()).hexdigest()}
    results = {}
    (ROOT / ".cache").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=ROOT / ".cache") as tmp:
        for name, features, extra in (("v2", "v2", []), ("v2-empty", "v2-empty", []), ("v2-seat-priors", "v2", ["seat-priors"])):
            path = Path(tmp) / f"warm-{features}.zapw"
            if not path.exists():
                write_model(actor, path, meta=meta, features=features)
            cmd = ["node", "training/tests/warm_start_check.ts", args.v1, str(path), str(args.matches), args.seed, *extra]
            out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True)
            r = json.loads(out.stdout.strip().splitlines()[-1])
            results[name] = r
            hooked = f", statistics changed by the seat priors on {r['hookedStates']} states" if extra else ""
            print(f"{name}: {r['decisions']} decisions in {r['matches']} matches, mismatches {r['mismatches']} (untraced {r['untracedMismatches']}), "
                  f"max logit difference {r['maxLogitDiff']:.2e}, value {r['maxValueDiff']:.2e}, probability {r['maxProbDiff']:.2e}{hooked}")
    ok = all(r["ok"] for r in results.values())
    facts = {
        "warmStart": {
            "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "method": f"The warm start network (v1 weights, zero weights on the 30 statistics inputs, f32) against v1 (int8) with the shipped Zap knobs: {args.matches} matches per segment (seed {args.seed}) played in lockstep, every seat by the same network, with the public match context passed; action logs compared, raw logits, value head and action probabilities compared on every visited state. Repeated with features v2-empty, and with features v2 whose context carries a prior per seat far from the population one (the profile hook of ai/src/opponent-stats.ts, off in the room; hookedStates: states whose statistics inputs it changed).",
            "v1": args.v1,
            "matchesPerVersion": args.matches * 4,
            **{f: {k: results[f][k] for k in ("matches", "decisions", "mismatches", "untracedMismatches", "maxLogitDiff", "maxValueDiff", "maxProbDiff") + (("hookedStates",) if f == "v2-seat-priors" else ())} for f in results},
            "tolerance": 1e-4,
            "pass": ok,
        }
    }
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"facts": facts, "results": results}, indent=2) + "\n")
    if args.write_facts:
        subprocess.run(["node", "ai/bench/adaptation-facts.ts", str(out)], cwd=ROOT, check=True, capture_output=True)
    assert ok, "the warm start does not play as v1"
    print("warm start OK")


if __name__ == "__main__":
    main()
