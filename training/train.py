"""Training loop: self-play workers in Node write decisions, the learner updates the network.

Usage (inside the train container):
  python training/train.py --run training/runs/r1 --iters 400 --imitation-iters 20

Each iteration: export the current actor, run the workers in parallel, load their records,
update (imitation for the first iterations, then an optional critic warm-up with the actor
frozen, then PPO), and from time to time save a league snapshot and evaluate in the duplicate
format. Everything needed to resume lives in the run folder.

Features v2 (--features v2 --priors ai/models/opponent-priors.json) add public statistics of the
other players in the match; --features v2-empty trains the twin, which has the same inputs with
the statistics always at no evidence. --init-actor starts from a warm start file
(training/warm_start.py) instead of random weights. --no-stats-share (default 0.15) plays that
share of the matches blind: the learning seats read no statistics for the whole match, so the
no-evidence policy is trained after hand 1 too.

The trained explorer of the explorer test (project_docs/ai.md) uses four more options:
--features v2-self (the statistics block describes the seat itself, the next seat and the partner),
--league-as-served (the league files play as the room serves them: Zap knobs, statistics live,
their safety net), --episode match (one episode per seat per match, so credit flows across hands)
and --eval-served FILE (the periodic check plays that file with the statistics live and at no
evidence instead of the heuristic).

The feints fine-tune of milestone 6 adds three options. --resume-from RUN continues another run
folder into this one: when this folder has no checkpoint yet, the learner state of RUN/checkpoint.pt
(actor, critic, anchor, both optimizers, iteration) and RUN's last --league-size snapshots are
copied in (RUN is only read; resumed-from.json records what was taken), then the loop goes on from
the next iteration up to --iters, with this run's own league mix. --feint-hands and --feint-evidence
set the switch points of the 'feints' kind of --league-mix (opponents that fake a pattern, then
switch: ai/src/league.ts).

The training cycle (training/cycle) adds two league options. --league-fixed a.zapw,b.zapw keeps
model files (the last promoted versions) in the league for the whole run, after the window of the
run's own snapshots (--league-size), so the window holds only snapshots. --human-model FILE gives
the self-play workers the cycle's human behaviour model for the 'human' kind of --league-mix, which
seats it as an opponent and, through the partner swap, as a partner.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from learner import Learner, load_batches, write_model  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

M6_MIX = "current=0.30,snapshots=0.10,v1=0.08,tuned=0.05,base=0.05,random=0.02,characters=0.16,extremes=0.14,switching=0.10"

ENCODER_JS = """
import { readFileSync } from 'node:fs';
const f = await import('./ai/src/features.ts');
const s = await import('./ai/src/opponent-stats.ts');
const [version, priorsPath] = [process.argv[1], process.argv[2]];
const priors = priorsPath ? s.validatePriors(JSON.parse(readFileSync(priorsPath, 'utf8'))) : null;
console.log(JSON.stringify({ info: f.encoderInfo(version, priors), priors, segments: s.SEGMENTS }));
"""


def encoder_info(features: str, priors_path: str) -> dict:
    """Input size, critic size, statistics offset and size, the no-evidence block per segment, and the validated priors."""
    cmd = ["node", "--input-type=module", "-e", ENCODER_JS, features, priors_path]
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def log(run: Path, msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(run / "train.log", "a") as fh:
        fh.write(line + "\n")


def fixed_league(args: argparse.Namespace) -> list[str]:
    """--league-fixed: model files in the league for the whole run, after the window of snapshots."""
    return [p for p in args.league_fixed.split(",") if p]


def pair(text: str) -> list[int]:
    lo, hi = (int(v) for v in text.split(","))
    return [lo, hi]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def continue_from(run: Path, src: Path, learner: Learner, league_size: int, features: str) -> int:
    """--resume-from: loads src's checkpoint into the learner and copies its last league_size snapshots
    into run/league. Returns the first iteration to play. src is only read."""
    src_args = json.loads((src / "args.json").read_text()) if (src / "args.json").exists() else {}
    if src_args.get("features", features) != features:
        raise SystemExit(f"--resume-from {src}: features {src_args.get('features')}, this run {features}")
    ckpt = src / "checkpoint.pt"
    extra = learner.load(ckpt)
    snaps = sorted((src / "league").glob("it*.zapw"))[-league_size:] if league_size > 0 else []
    (run / "league").mkdir(parents=True, exist_ok=True)
    for p in snaps:
        shutil.copy(p, run / "league" / p.name)
    record = {
        "from": str(src.relative_to(ROOT)) if src.is_relative_to(ROOT) else str(src),
        "checkpoint": {"sha256": sha256_file(ckpt), "iteration": extra["iteration"]},
        "snapshots": [{"name": p.name, "sha256": sha256_file(p)} for p in snaps],
        "sourceArgs": src_args,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (run / "resumed-from.json").write_text(json.dumps(record, indent=2))
    return extra["iteration"] + 1


def run_workers(run: Path, it: int, args: argparse.Namespace, teacher: bool, league: list[str]) -> tuple[list[Path], list[dict]]:
    batches = run / "batches"
    batches.mkdir(exist_ok=True)
    procs = []
    outs = []
    per = args.decisions // args.workers
    lo, hi = (int(v) for v in args.switch_hands.split(","))
    for k in range(args.workers):
        out = batches / f"{it:06d}-{k}.bin"
        job = {
            "model": str(run / "current.zapw"),
            "out": str(out),
            "decisions": per,
            "seed": f"{args.seed_base}{it:08x}{k:08x}".ljust(64, "0")[:64],
            "league": league[-args.league_size :] + fixed_league(args),
            "mix": args.league_mix,
            "twoStyles": args.two_styles,
            "partnerSwap": 0.0 if teacher else args.partner_swap,
            "fourPlayers": args.four_players,
            "mineiro": args.mineiro,
            "randomOptions": args.random_options,
            "v1Model": args.v1_model,
            "v1Manifest": args.v1_manifest,
            "switchHands": [lo, hi],
            "feintHands": pair(args.feint_hands),
            "feintEvidence": pair(args.feint_evidence),
            "noStatsShare": args.no_stats_share,
        }
        if args.league_as_served:
            job["leagueAsServed"] = True
        if args.episode != "hand":
            job["episode"] = args.episode
        if args.human_model:
            job["human"] = args.human_model
        if args.heuristic_params:
            job["heuristicParams"] = json.loads((ROOT / args.heuristic_params).read_text())["params"]
        if teacher:
            job["teacher"] = "heuristic"
        jp = batches / f"{it:06d}-{k}.job.json"
        jp.write_text(json.dumps(job))
        procs.append(subprocess.Popen(["node", "training/src/selfplay.ts", "--config", str(jp)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        outs.append(out)
    stats = []
    for p in procs:
        so, se = p.communicate()
        if p.returncode != 0:
            raise RuntimeError(f"self-play worker failed: {se[-2000:]}")
        stats.append(json.loads(so.strip().splitlines()[-1]))
    return outs, stats


def node_json(cmd: list[str]) -> dict:
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def evaluate(run: Path, pairs: int, params: str | None, against: str = "heuristic") -> dict:
    cmd = ["node", "training/src/eval.ts", "--model", str(run / "current.zapw"), "--pairs", str(pairs), "--against", against]
    if params:
        cmd += ["--params", params]
    return node_json(cmd)


def served_check(run: Path, args: argparse.Namespace) -> dict:
    """--eval-served: the current network against that file with the statistics live and at no evidence."""
    cmd = ["node", "training/src/eval.ts", "--model", str(run / "current.zapw"), "--served", args.eval_served, "--pairs", str(args.eval_pairs), "--threads", str(args.threads)]
    return node_json(cmd)["served"]


def panel(run: Path, args: argparse.Namespace) -> dict:
    """Base heuristic, tuned heuristic and v1, and (features v2) the quick adaptation check."""
    model = str(run / "current.zapw")
    out = {"panel": node_json(["node", "training/src/eval.ts", "--model", model, "--panel", "--pairs", str(args.panel_pairs), "--threads", str(args.threads)])["panel"]}
    if args.features == "v2":
        out["adapt_quick"] = node_json(["node", "ai/bench/adaptation-sweep.ts", "--quick", "--model", model, "--pairs", str(args.panel_pairs), "--threads", str(args.threads)])["quick"]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--iters", type=int, default=400)
    ap.add_argument("--imitation-iters", type=int, default=20)
    ap.add_argument("--critic-warmup", type=int, default=0, help="iterations after imitation with the actor frozen, training only the critic")
    ap.add_argument("--decisions", type=int, default=120_000)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--eval-every", type=int, default=10)
    ap.add_argument("--eval-pairs", type=int, default=200)
    ap.add_argument("--panel-every", type=int, default=0, help="every N iterations: base, tuned and v1 panel, and the quick adaptation check (0: never)")
    ap.add_argument("--panel-pairs", type=int, default=100)
    ap.add_argument("--league-every", type=int, default=10)
    ap.add_argument("--league-size", type=int, default=8)
    ap.add_argument("--league-fixed", default="", help="model files always in the league, after the window of snapshots: the last promoted versions (training cycle)")
    ap.add_argument("--magnet-every", type=int, default=20)
    ap.add_argument("--league-mix", default=M6_MIX, help="shares of opponent kinds per match (ai/src/league.ts)")
    ap.add_argument("--human-model", default="", help="the training cycle's human behaviour model (features v1), for the 'human' kind of the league mix")
    ap.add_argument("--two-styles", type=float, default=0.5, help="2 against 2: chance the second opponent is the same player as the first")
    ap.add_argument("--switch-hands", default="1,6", help="hands before a switching opponent changes style: from,to")
    ap.add_argument("--feint-hands", default="1,8", help="'feints' kind: hands of the first phase when the switch waits for a hand: from,to")
    ap.add_argument("--feint-evidence", default="2,8", help="'feints' kind: betting events of the seat before the switch when it waits for evidence: from,to")
    ap.add_argument("--resume-from", default="", help="run folder to continue when this run has no checkpoint yet: its checkpoint and last --league-size snapshots (only read)")
    ap.add_argument("--partner-swap", type=float, default=0.2)
    ap.add_argument("--four-players", type=float, default=0.5)
    ap.add_argument("--mineiro", type=float, default=0.5)
    ap.add_argument("--random-options", type=float, default=0.25)
    ap.add_argument("--hidden", default="256,256")
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--entropy", type=float, default=0.01)
    ap.add_argument("--magnet-kl", type=float, default=0.05)
    ap.add_argument("--features", default="v1", choices=["v1", "v2", "v2-empty", "v2-self"])
    ap.add_argument("--league-as-served", action="store_true", help="league files play as the room serves them (Zap knobs, statistics live, their safety net): the trained explorer")
    ap.add_argument("--episode", default="hand", choices=["hand", "match"], help="one episode per seat per hand, or per match (credit across hands: the trained explorer)")
    ap.add_argument("--eval-served", default="", help="adaptive file with its safety net: the periodic check plays it with the statistics live and at no evidence instead of the heuristic")
    ap.add_argument("--priors", default="", help="opponent priors (ai/models/opponent-priors.json), required for v2 and v2-empty")
    ap.add_argument("--init-actor", default="", help="actor state dict to start from (training/warm_start.py)")
    ap.add_argument("--adapt-beta", type=float, default=0.0, help="weight of the adaptation regularizer")
    ap.add_argument("--adapt-nw", type=float, default=2.0, help="evidence at which the regularizer weight halves")
    ap.add_argument("--no-stats-share", type=float, default=0.15, help="share of matches in which the learning seats read no statistics (trains the no-evidence policy after hand 1); the same in the adaptive run and the twin")
    ap.add_argument("--v1-model", default="ai/models/bootstrap/zap-v1.zapw")
    ap.add_argument("--v1-manifest", default="ai/models/bootstrap/manifest.json")
    ap.add_argument("--seed-base", default="5a")
    ap.add_argument("--max-hours", type=float, default=0)
    ap.add_argument("--heuristic-params", default="", help="JSON from ai/bench/tune-heuristic.ts, used as teacher, opponent and evaluation reference")
    args = ap.parse_args()
    if args.features != "v1" and not args.priors:
        ap.error("--priors is required for features v2 and v2-empty")
    for f in fixed_league(args) + ([args.human_model] if args.human_model else []) + ([args.eval_served] if args.eval_served else []):
        if not (ROOT / f).is_file():
            ap.error(f"league file not found: {f}")
    if args.resume_from and not (ROOT / args.resume_from / "checkpoint.pt").is_file():
        ap.error(f"--resume-from: no checkpoint.pt in {args.resume_from}")
    if args.resume_from and (ROOT / args.resume_from).resolve() == (ROOT / args.run).resolve():
        ap.error("--resume-from names this run's own folder")
    shares = dict(part.split("=", 1) for part in args.league_mix.split(",") if "=" in part)
    if float(shares.get("human", 0)) > 0 and not args.human_model:
        ap.error("a league mix with a 'human' share needs --human-model")

    torch.set_num_threads(args.threads)
    run = (ROOT / args.run) if not Path(args.run).is_absolute() else Path(args.run)
    run.mkdir(parents=True, exist_ok=True)
    (run / "league").mkdir(exist_ok=True)
    (run / "args.json").write_text(json.dumps(vars(args), indent=2))
    enc = encoder_info(args.features, args.priors)
    info = enc["info"]
    meta_base: dict = {}
    if args.features != "v1":
        meta_base = {"priors": enc["priors"], "priorsSha256": hashlib.sha256((ROOT / args.priors).read_bytes()).hexdigest()}
    # The adaptation regularizer concerns networks that read the other players (v2, and the twin
    # where it is exactly 0); the explorer's v2-self block describes itself, so it has none.
    reg_size = info["statsSize"] if args.features != "v2-self" else 0
    empty = None
    if reg_size:
        empty = torch.tensor([info["empty"][seg] for seg in enc["segments"]], dtype=torch.float32)
    learner = Learner(
        info["size"],
        info["critic"],
        hidden=[int(h) for h in args.hidden.split(",")],
        stats_offset=info["statsOffset"] if reg_size else 0,
        stats_size=reg_size,
        empty=empty,
    )
    learner.hyper.lr = args.lr
    learner.hyper.entropy = args.entropy
    learner.hyper.magnet_kl = args.magnet_kl
    learner.hyper.adapt_beta = args.adapt_beta
    learner.hyper.adapt_nw = args.adapt_nw
    for g in learner.opt_actor.param_groups:
        g["lr"] = args.lr
    start = 0
    ckpt = run / "checkpoint.pt"
    if ckpt.exists():
        extra = learner.load(ckpt)
        start = extra["iteration"] + 1
        log(run, f"resumed at iteration {start}")
    elif args.resume_from:
        start = continue_from(run, ROOT / args.resume_from, learner, args.league_size, args.features)
        log(run, f"continued {args.resume_from} at iteration {start}")
    elif args.init_actor:
        state = torch.load(ROOT / args.init_actor, weights_only=True)
        learner.actor.load_state_dict(state)
        learner.magnet.load_state_dict(state)
        log(run, f"actor and anchor from {args.init_actor}")
    warm_end = args.imitation_iters + args.critic_warmup
    t_start = time.time()
    for it in range(start, args.iters):
        t0 = time.time()
        write_model(learner.actor, run / "current.zapw", meta={**meta_base, "iteration": it}, features=args.features)
        teacher = it < args.imitation_iters
        warmup = not teacher and it < warm_end
        league = sorted(str(p) for p in (run / "league").glob("*.zapw"))
        paths, wstats = run_workers(run, it, args, teacher, league)
        t1 = time.time()
        rec = load_batches(paths)
        if teacher:
            metrics, mode = learner.imitation_step(rec), "imitation"
        elif warmup:
            metrics, mode = learner.critic_step(rec), "critic"
        else:
            metrics, mode = learner.ppo_step(rec), "ppo"
        for p in paths:
            p.unlink(missing_ok=True)
            Path(str(p) + ".json").unlink(missing_ok=True)
        for jp in (run / "batches").glob(f"{it:06d}-*.job.json"):
            jp.unlink()
        t2 = time.time()
        if (teacher and it == args.imitation_iters - 1) or (it >= warm_end and (it - warm_end) % args.magnet_every == args.magnet_every - 1):
            learner.refresh_magnet()
        write_model(learner.actor, run / "current.zapw", meta={**meta_base, "iteration": it + 1}, features=args.features)
        if (it + 1) % args.league_every == 0:
            shutil.copy(run / "current.zapw", run / "league" / f"it{it + 1:06d}.zapw")
        setups: dict[str, int] = {}
        for s in wstats:
            for k, v in s.get("setups", {}).items():
                setups[k] = setups.get(k, 0) + v
        entry = {
            "iteration": it,
            "mode": mode,
            "decisions": int(len(rec)),
            "hands": sum(s["hands"] for s in wstats),
            "matches": sum(s["matches"] for s in wstats),
            "selfplay_seconds": round(t1 - t0, 1),
            "learn_seconds": round(t2 - t1, 1),
            "mean_evidence": round(sum(s.get("meanEvidence", 0) * s["decisions"] for s in wstats) / max(1, sum(s["decisions"] for s in wstats)), 4),
            "blind_matches": sum(s.get("blindMatches", 0) for s in wstats),
            **{k: round(v, 7 if k.startswith("kl_adapt") else 5) for k, v in metrics.items()},
            "setups": setups,
        }
        t3 = time.time()
        if (it + 1) % args.eval_every == 0 and args.eval_served:
            sv = served_check(run, args)
            entry["vs_served"] = round(sv["on"], 4)
            entry["vs_served_ablated"] = round(sv["ablated"], 4)
            entry["served_reading"] = {"mean": round(sv["reading"]["mean"], 5), "se": round(sv["reading"]["se"], 5)}
        elif (it + 1) % args.eval_every == 0:
            ev = evaluate(run, args.eval_pairs, args.heuristic_params or None)
            entry["vs_heuristic"] = round(ev["mean"], 4)
            entry["vs_heuristic_segments"] = {k: round(v["mean"], 4) for k, v in ev["results"].items()}
        if args.panel_every and (it + 1) % args.panel_every == 0:
            entry.update(panel(run, args))
        entry["eval_seconds"] = round(time.time() - t3, 1)
        with open(run / "metrics.jsonl", "a") as fh:
            fh.write(json.dumps(entry) + "\n")
        log(run, json.dumps(entry))
        learner.save(ckpt, {"iteration": it})
        if args.max_hours and time.time() - t_start > args.max_hours * 3600:
            log(run, "time budget reached")
            break


if __name__ == "__main__":
    main()
