"""Summary of training runs for facts.json (ai.adaptation.training): iterations, hours, seconds
per iteration (self-play, learning, evaluations), the last score against the tuned heuristic,
the last panel and the adaptation KL by evidence bucket. Reads metrics.jsonl and args.json of
each run.

  docker compose --profile train run --rm -T train python training/report_runs.py \
      --runs training/runs/m6-adaptive,training/runs/m6-twin [--out training/runs/m6-adaptive/eval/training.json] [--write-facts]
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def summarize(run: Path) -> dict:
    args = json.loads((run / "args.json").read_text())
    rows = [json.loads(line) for line in (run / "metrics.jsonl").read_text().splitlines() if line.strip()]
    ppo = [r for r in rows if r["mode"] == "ppo"]
    total = sum(r["selfplay_seconds"] + r["learn_seconds"] + r.get("eval_seconds", 0) for r in rows)
    last_eval = next((r for r in reversed(rows) if "vs_heuristic" in r), None)
    last_panel = next((r for r in reversed(rows) if "panel" in r), None)
    tail = ppo[-10:]
    kl = {k: round(statistics.fmean(r.get(k, 0.0) for r in tail), 7) for k in ("kl_adapt", "kl_adapt_n0", "kl_adapt_n1_2", "kl_adapt_n3p")} if tail else None
    med = lambda xs: round(statistics.median(xs), 2) if xs else None  # noqa: E731
    return {
        "run": str(run.relative_to(ROOT)) if run.is_relative_to(ROOT) else str(run),
        "features": args.get("features", "v1"),
        "adaptBeta": args.get("adapt_beta"),
        "adaptNW": args.get("adapt_nw"),
        "noStatsShare": args.get("no_stats_share"),
        "blindMatchShare": round(sum(r.get("blind_matches", 0) for r in rows) / max(1, sum(r.get("matches", 0) for r in rows)), 4),
        "seedBase": args.get("seed_base"),
        "iterations": len(rows),
        "ppoIterations": len(ppo),
        "criticWarmupIterations": sum(1 for r in rows if r["mode"] == "critic"),
        "hours": round(total / 3600, 3),
        "decisionsPerIteration": med([r["decisions"] for r in rows]),
        "secondsPerIteration": {
            "selfplayMedian": med([r["selfplay_seconds"] for r in ppo]),
            "learnMedian": med([r["learn_seconds"] for r in ppo]),
            "meanWithEvaluations": round(total / len(rows), 2) if rows else None,
        },
        "finalVsTunedHeuristic": {"iteration": last_eval["iteration"] + 1, "mean": last_eval["vs_heuristic"], "segments": last_eval.get("vs_heuristic_segments"), "pairsPerSegment": args.get("eval_pairs")} if last_eval else None,
        "finalPanel": {"iteration": last_panel["iteration"] + 1, "panel": last_panel["panel"], "adaptQuick": last_panel.get("adapt_quick"), "pairsPerSegment": args.get("panel_pairs")} if last_panel else None,
        "klAdaptLast10": kl,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--write-facts", action="store_true")
    args = ap.parse_args()
    runs = [ROOT / r for r in args.runs.split(",")]
    summary = {r.name: summarize(r) for r in runs}
    facts = {
        "training": {
            "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "method": "From each run's metrics.jsonl and args.json (training/train.py): wall time per iteration on this machine (4 self-play workers, 4 learner threads), the last periodic duplicate evaluation against the tuned heuristic and the last panel evaluation.",
            "runs": summary,
        }
    }
    out = ROOT / (args.out or f"{args.runs.split(',')[0]}/eval/training.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"facts": facts}, indent=2) + "\n")
    if args.write_facts:
        subprocess.run(["node", "ai/bench/adaptation-facts.ts", str(out)], cwd=ROOT, check=True, capture_output=True)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
