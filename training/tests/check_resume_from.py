"""Checks train.py --resume-from (continue_from): the learner state of the source checkpoint is
loaded exactly (actor, critic, anchor, both optimizers), the next iteration follows the source's
last one, only the last --league-size snapshots are copied, the source folder is left as it was,
resumed-from.json records the checkpoint and snapshot hashes, and a run with other features is
refused.

  docker compose --profile train run --rm -T train python training/tests/check_resume_from.py
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
from learner import Learner  # noqa: E402
from train import continue_from  # noqa: E402

FEATURES, CRITIC = 461, 135
TMP = ROOT / ".cache" / "tmp" / "check-resume-from"


def digest(folder: Path) -> dict[str, str]:
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.rglob("*")) if p.is_file()}


def same_state(a: dict, b: dict) -> bool:
    return a.keys() == b.keys() and all(torch.equal(a[k], b[k]) for k in a)


def main() -> None:
    shutil.rmtree(TMP, ignore_errors=True)
    src = TMP / "source"
    run = TMP / "continued"
    (src / "league").mkdir(parents=True)
    run.mkdir(parents=True)
    torch.manual_seed(7)
    a = Learner(FEATURES, CRITIC, hidden=[32, 16])
    with torch.no_grad():
        for p in a.actor.parameters():
            p.add_(torch.randn_like(p))
        for p in a.critic.parameters():
            p.add_(torch.randn_like(p))
    a.refresh_magnet()
    with torch.no_grad():
        for p in a.actor.parameters():
            p.mul_(1.5)
    # One optimizer step each, so the optimizer states are not empty.
    for opt, net in ((a.opt_actor, a.actor), (a.opt_critic, a.critic)):
        loss = sum((p**2).sum() for p in net.parameters())
        opt.zero_grad()
        loss.backward()
        opt.step()
    a.save(src / "checkpoint.pt", {"iteration": 389})
    for it in range(10, 400, 10):
        (src / "league" / f"it{it:06d}.zapw").write_bytes(f"snapshot {it}".encode())
    (src / "args.json").write_text(json.dumps({"features": "v2", "iters": 390}))
    before = digest(src)

    b = Learner(FEATURES, CRITIC, hidden=[32, 16])
    start = continue_from(run, src, b, 8, "v2")
    assert start == 390, start
    assert same_state(a.actor.state_dict(), b.actor.state_dict()), "actor differs"
    assert same_state(a.critic.state_dict(), b.critic.state_dict()), "critic differs"
    assert same_state(a.magnet.state_dict(), b.magnet.state_dict()), "anchor differs"
    assert not same_state(b.actor.state_dict(), b.magnet.state_dict()), "anchor must stay the source's anchor, not the actor"
    for x, y in ((a.opt_actor, b.opt_actor), (a.opt_critic, b.opt_critic)):
        sx, sy = x.state_dict()["state"], y.state_dict()["state"]
        assert sx.keys() == sy.keys() and all(torch.equal(sx[k]["exp_avg"], sy[k]["exp_avg"]) for k in sx), "optimizer state differs"
    names = sorted(p.name for p in (run / "league").glob("*.zapw"))
    assert names == [f"it{it:06d}.zapw" for it in range(320, 400, 10)], names
    rec = json.loads((run / "resumed-from.json").read_text())
    assert rec["checkpoint"]["iteration"] == 389 and rec["checkpoint"]["sha256"] == before["checkpoint.pt"]
    assert [s["name"] for s in rec["snapshots"]] == names
    assert digest(src) == before, "the source folder changed"
    try:
        continue_from(TMP / "other", src, Learner(FEATURES, CRITIC, hidden=[32, 16]), 8, "v2-empty")
    except SystemExit as e:
        assert "features" in str(e)
    else:
        raise AssertionError("a run with other features must be refused")
    shutil.rmtree(TMP, ignore_errors=True)
    print("resume-from OK: state loaded exactly, next iteration 390, 8 snapshots copied, source unchanged")


if __name__ == "__main__":
    main()
