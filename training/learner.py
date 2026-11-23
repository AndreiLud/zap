"""Learner for the Zap network: imitation warm start and regularized PPO.

The actor network (what plays online) sees only what its seat sees. The critic, used only in
training, also sees the other seats' hidden cards, which lowers the variance of the advantages.
Each hand is one episode per seat; the reward at the end of the hand is the change in the
team's chance of winning the match (training/src/selfplay.ts writes it). The trained explorer of
the explorer test uses one episode per seat per match instead, with the same hand rewards, so its
early play is credited with what it earns in later hands.

Features v2 add public statistics of the other players in the match. A regularizer keeps the
policy that reads them close to the same network with the statistics at no evidence, with a
weight that shrinks as the evidence n behind the decision grows: adjustments start small and
grow with the evidence.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

NUM_ACTIONS = 15
MAGIC = 0x5750415A


def record_dtype(features: int, critic: int, extra: int = 16) -> np.dtype:
    fields = [
        ("x", "u1", (features,)),
        ("c", "u1", (critic,)),
        ("mask", "<u2"),
        ("a", "u1"),
        ("flags", "u1"),
        ("logp", "<f4"),
        ("r", "<f4"),
        ("ep", "<u4"),
    ]
    if extra == 20:
        # Decision evidence n (capped at 255), then padding to a multiple of 4 bytes.
        fields += [("nev", "u1"), ("pad", "u1", (3,))]
    elif extra != 16:
        raise ValueError(f"unknown record tail of {extra} bytes")
    return np.dtype(fields)


FLAG_DONE = 1
FLAG_MATCH_WON = 2
FLAG_FOUR = 4


def load_batches(paths: list[Path]) -> np.ndarray:
    parts = []
    for p in paths:
        meta = json.loads(Path(str(p) + ".json").read_text())
        dt = record_dtype(meta["features"], meta["critic"], meta.get("extra", 16))
        assert dt.itemsize == meta["recordSize"], "record layout changed"
        parts.append(np.fromfile(p, dtype=dt))
    return np.concatenate(parts) if parts else np.zeros(0)


class Actor(nn.Module):
    def __init__(self, inputs: int, hidden: list[int]):
        super().__init__()
        layers = []
        prev = inputs
        for h in hidden:
            layers.append(nn.Linear(prev, h))
            prev = h
        self.trunk = nn.ModuleList(layers)
        self.policy = nn.Linear(prev, NUM_ACTIONS)
        self.value = nn.Linear(prev, 1)
        self.inputs = inputs
        self.hidden = hidden

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = x
        for layer in self.trunk:
            h = F.relu(layer(h))
        return self.policy(h), self.value(h).squeeze(-1)


class Critic(nn.Module):
    def __init__(self, inputs: int, hidden: list[int]):
        super().__init__()
        dims = [inputs, *hidden]
        self.layers = nn.ModuleList([nn.Linear(a, b) for a, b in zip(dims[:-1], dims[1:])])
        self.out = nn.Linear(dims[-1], 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = x
        for layer in self.layers:
            h = F.relu(layer(h))
        return self.out(h).squeeze(-1)


def masked_logits(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    bits = torch.arange(NUM_ACTIONS, device=mask.device)
    legal = ((mask.unsqueeze(-1) >> bits) & 1).bool()
    return logits.masked_fill(~legal, -1e9)


# ---------------------------------------------------------------------------------------------
# Model files (same format as ai/src/mlp.ts)


def write_model(actor: Actor, path: Path, dtype: str = "f32", meta: dict | None = None, features: str = "v1") -> bytes:
    layers = [(f"trunk.{i}", l) for i, l in enumerate(actor.trunk)] + [("policy", actor.policy), ("value", actor.value)]
    tensors = []
    chunks: list[bytes] = []
    offset = 0

    def push(b: bytes) -> int:
        nonlocal offset
        pad = (4 - len(b) % 4) % 4
        chunks.append(b + b"\0" * pad)
        at = offset
        offset += len(b) + pad
        return at

    for name, l in layers:
        w = l.weight.detach().cpu().numpy().astype(np.float32)
        b = l.bias.detach().cpu().numpy().astype(np.float32)
        rows, cols = w.shape
        if dtype == "f32":
            tensors.append({"name": f"{name}.weight", "shape": [rows, cols], "dtype": "f32", "offset": push(w.tobytes())})
        else:
            mx = np.abs(w).max(axis=1)
            scale = np.where(mx > 0, mx / 127.0, 1.0).astype(np.float32)
            q = np.round(w / scale[:, None]).astype(np.int8)
            info = {"name": f"{name}.weight", "shape": [rows, cols], "dtype": "i8", "offset": push(q.tobytes())}
            info["scaleOffset"] = push(scale.tobytes())
            tensors.append(info)
        tensors.append({"name": f"{name}.bias", "shape": [rows], "dtype": "f32", "offset": push(b.tobytes())})
    header = {
        "arch": "mlp-v1",
        "features": features,
        "inputs": actor.inputs,
        "hidden": actor.hidden,
        "policy": NUM_ACTIONS,
        "value": 1,
        "tensors": tensors,
    }
    if meta:
        header["meta"] = meta
    hb = json.dumps(header, separators=(",", ":")).encode()
    out = struct.pack("<III", MAGIC, 1, len(hb)) + hb + b"\0" * ((4 - len(hb) % 4) % 4) + b"".join(chunks)
    tmp = Path(str(path) + ".tmp")
    tmp.write_bytes(out)
    tmp.replace(path)
    return out


def episode_runs(rec: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Record order grouped by episode, and for each position whether the next one continues the
    same episode. Episode ids restart in every self-play worker, so a run of one id ends at its done
    flag (the last decision of the episode), not only where the id changes."""
    order = np.argsort(rec["ep"], kind="stable")
    ep = rec["ep"][order]
    done = (rec["flags"][order] & FLAG_DONE) > 0
    same_next = np.zeros(len(order), dtype=bool)
    same_next[:-1] = (ep[1:] == ep[:-1]) & ~done[:-1]
    return order, same_next


def mc_returns(rec: np.ndarray) -> np.ndarray:
    """Monte Carlo return of every decision: the rewards from it to the end of its episode (gamma 1).
    With one episode per hand the reward comes only at the end, so every decision gets the hand's
    reward; with one episode per match (selfplay.ts episode 'match') it is the reward still to come."""
    order, same_next = episode_runs(rec)
    r = rec["r"][order].astype(np.float64)
    out = np.zeros(len(order))
    running = 0.0
    for i in range(len(order) - 1, -1, -1):
        running = r[i] + (running if same_next[i] else 0.0)
        out[i] = running
    res = np.empty(len(order), dtype=np.float32)
    res[order] = out
    return res


# ---------------------------------------------------------------------------------------------
# Training


@dataclass
class Hyper:
    lr: float = 3e-4
    critic_lr: float = 1e-3
    epochs: int = 4
    minibatch: int = 4096
    clip: float = 0.2
    entropy: float = 0.01
    magnet_kl: float = 0.05
    win_head: float = 0.5
    gae_lambda: float = 0.95
    max_grad_norm: float = 1.0
    # Adaptation regularizer: beta * mean[w(n) * KL(pi(.|x) || stopgrad pi(.|x0))], w(n) = nW / (nW + n).
    adapt_beta: float = 0.0
    adapt_nw: float = 2.0


@dataclass
class Learner:
    features: int
    critic_extra: int
    hidden: list[int] = field(default_factory=lambda: [256, 256])
    hyper: Hyper = field(default_factory=Hyper)
    # Features v2: where the statistics block sits, and the quantized no-evidence block per segment
    # ([4, stats_size], order paulista-2, paulista-4, mineiro-2, mineiro-4).
    stats_offset: int = 0
    stats_size: int = 0
    empty: torch.Tensor | None = None

    def __post_init__(self) -> None:
        torch.manual_seed(1234)
        self.actor = Actor(self.features, self.hidden)
        self.critic = Critic(self.features + self.critic_extra, self.hidden)
        self.magnet = Actor(self.features, self.hidden)
        self.magnet.load_state_dict(self.actor.state_dict())
        self.opt_actor = torch.optim.Adam(self.actor.parameters(), lr=self.hyper.lr)
        self.opt_critic = torch.optim.Adam(self.critic.parameters(), lr=self.hyper.critic_lr)

    # -- state ------------------------------------------------------------------------------
    def save(self, path: Path, extra: dict) -> None:
        tmp = Path(str(path) + ".tmp")
        torch.save(
            {
                "actor": self.actor.state_dict(),
                "critic": self.critic.state_dict(),
                "magnet": self.magnet.state_dict(),
                "opt_actor": self.opt_actor.state_dict(),
                "opt_critic": self.opt_critic.state_dict(),
                "extra": extra,
            },
            tmp,
        )
        tmp.replace(path)

    def load(self, path: Path) -> dict:
        ck = torch.load(path, weights_only=False)
        self.actor.load_state_dict(ck["actor"])
        self.critic.load_state_dict(ck["critic"])
        self.magnet.load_state_dict(ck["magnet"])
        self.opt_actor.load_state_dict(ck["opt_actor"])
        self.opt_critic.load_state_dict(ck["opt_critic"])
        return ck["extra"]

    def refresh_magnet(self) -> None:
        self.magnet.load_state_dict(self.actor.state_dict())

    # -- data -------------------------------------------------------------------------------
    @staticmethod
    def tensors(rec: np.ndarray) -> dict[str, torch.Tensor]:
        x = torch.from_numpy(rec["x"].astype(np.float32) / 255.0)
        c = torch.from_numpy(rec["c"].astype(np.float32) / 255.0)
        out = {
            "x": x,
            "xc": torch.cat([x, c], dim=1),
            "mask": torch.from_numpy(rec["mask"].astype(np.int64)),
            "a": torch.from_numpy(rec["a"].astype(np.int64)),
            "logp": torch.from_numpy(rec["logp"].astype(np.float32)),
            "won": torch.from_numpy(((rec["flags"] & FLAG_MATCH_WON) > 0).astype(np.float32)),
            # Segment from the first two inputs (mineiro bit, four players bit).
            "seg": (2 * (x[:, 0] > 0.5).long() + (x[:, 1] > 0.5).long()),
        }
        if "nev" in rec.dtype.names:
            out["nev"] = torch.from_numpy(rec["nev"].astype(np.float32))
        else:
            out["nev"] = torch.zeros(len(rec))
        return out

    def no_evidence(self, x: torch.Tensor, seg: torch.Tensor) -> torch.Tensor:
        """x with the statistics block replaced by the no-evidence block of each row's segment."""
        x0 = x.clone()
        so, ss = self.stats_offset, self.stats_size
        x0[:, so : so + ss] = self.empty[seg]
        return x0

    def adapt_weight(self, nev: torch.Tensor) -> torch.Tensor:
        """w(n) = nW / (nW + n): 1 without evidence, 1/2 at n = nW."""
        return self.hyper.adapt_nw / (self.hyper.adapt_nw + nev)

    def adapt_kl(self, x: torch.Tensor, seg: torch.Tensor, mask: torch.Tensor, logp_all: torch.Tensor) -> torch.Tensor:
        """KL(pi(.|x) || stopgrad pi(.|x0)) per row, over legal actions, with the magnet term's clamping."""
        with torch.no_grad():
            logp0 = F.log_softmax(masked_logits(self.actor(self.no_evidence(x, seg))[0], mask), dim=-1)
        return (logp_all.exp() * (logp_all.clamp(min=-30) - logp0.clamp(min=-30))).sum(-1)

    def advantages(self, rec: np.ndarray, values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """GAE inside each episode (one seat in one hand, or in one match), gamma 1."""
        order, same_next = episode_runs(rec)
        r = rec["r"][order].astype(np.float64)
        v = values[order].astype(np.float64)
        n = len(order)
        v_next = np.zeros(n)
        v_next[:-1] = np.where(same_next[:-1], v[1:], 0.0)
        delta = r + v_next - v
        adv = np.zeros(n)
        lam = self.hyper.gae_lambda
        running = 0.0
        for i in range(n - 1, -1, -1):
            running = delta[i] + (lam * running if same_next[i] else 0.0)
            adv[i] = running
        out_adv = np.empty(n)
        out_adv[order] = adv
        returns = out_adv + values
        return out_adv.astype(np.float32), returns.astype(np.float32)

    # -- updates ------------------------------------------------------------------------------
    def imitation_step(self, rec: np.ndarray, epochs: int = 2) -> dict:
        t = self.tensors(rec)
        n = len(rec)
        losses = []
        accs = []
        for _ in range(epochs):
            perm = torch.randperm(n)
            for i in range(0, n, self.hyper.minibatch):
                idx = perm[i : i + self.hyper.minibatch]
                logits, win = self.actor(t["x"][idx])
                logits = masked_logits(logits, t["mask"][idx])
                loss_pi = F.cross_entropy(logits, t["a"][idx])
                loss_win = F.binary_cross_entropy_with_logits(win, t["won"][idx])
                loss = loss_pi + self.hyper.win_head * loss_win
                self.opt_actor.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.actor.parameters(), self.hyper.max_grad_norm)
                self.opt_actor.step()
                losses.append(loss_pi.item())
                accs.append((logits.argmax(-1) == t["a"][idx]).float().mean().item())
        # Train the critic on the same data with the hand rewards as Monte Carlo returns.
        self.critic_only(rec)
        return {"imitation_loss": float(np.mean(losses[-10:])), "imitation_acc": float(np.mean(accs[-10:]))}

    def critic_step(self, rec: np.ndarray, epochs: int = 2) -> dict:
        """Critic warm-up: the actor is frozen, only the critic learns (on Monte Carlo returns)."""
        t = self.tensors(rec)
        ret = mc_returns(rec)
        self.critic_only(rec, epochs)
        with torch.no_grad():
            values = self.critic(t["xc"]).numpy()
        var_ret = float(np.var(ret))
        explained = 1 - float(np.var(ret - values)) / var_ret if var_ret > 0 else 0.0
        return {"v": float(np.mean((ret - values) ** 2)), "explained_variance_mc": explained}

    def critic_only(self, rec: np.ndarray, epochs: int = 2) -> None:
        t = self.tensors(rec)
        ret = torch.from_numpy(mc_returns(rec))
        n = len(rec)
        for _ in range(epochs):
            perm = torch.randperm(n)
            for i in range(0, n, self.hyper.minibatch):
                idx = perm[i : i + self.hyper.minibatch]
                loss = F.mse_loss(self.critic(t["xc"][idx]), ret[idx])
                self.opt_critic.zero_grad()
                loss.backward()
                self.opt_critic.step()

    def ppo_step(self, rec: np.ndarray) -> dict:
        h = self.hyper
        t = self.tensors(rec)
        with torch.no_grad():
            values = self.critic(t["xc"]).numpy()
            magnet_logits = masked_logits(self.magnet(t["x"])[0], t["mask"])
        adv, returns = self.advantages(rec, values)
        adv_t = torch.from_numpy(adv)
        adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)
        ret_t = torch.from_numpy(returns)
        n = len(rec)
        stats: dict[str, list[float]] = {k: [] for k in ["pi", "v", "ent", "kl_old", "kl_magnet", "clip", "win", "kl_adapt"]}
        # Raw KL of the adaptation term by evidence bucket (n = 0, 1 to 2, 3 or more): sums and counts.
        buckets = {"n0": [0.0, 0], "n1_2": [0.0, 0], "n3p": [0.0, 0]}
        for _ in range(h.epochs):
            perm = torch.randperm(n)
            for i in range(0, n, h.minibatch):
                idx = perm[i : i + h.minibatch]
                logits, win = self.actor(t["x"][idx])
                logits = masked_logits(logits, t["mask"][idx])
                logp_all = F.log_softmax(logits, dim=-1)
                logp = logp_all.gather(1, t["a"][idx].unsqueeze(1)).squeeze(1)
                ratio = torch.exp(logp - t["logp"][idx])
                a = adv_t[idx]
                loss_pi = -torch.min(ratio * a, torch.clamp(ratio, 1 - h.clip, 1 + h.clip) * a).mean()
                probs = logp_all.exp()
                ent = -(probs * logp_all.clamp(min=-30)).sum(-1).mean()
                mag = F.log_softmax(magnet_logits[idx], dim=-1)
                kl_m = (probs * (logp_all.clamp(min=-30) - mag.clamp(min=-30))).sum(-1).mean()
                loss_win = F.binary_cross_entropy_with_logits(win, t["won"][idx])
                loss = loss_pi - h.entropy * ent + h.magnet_kl * kl_m + h.win_head * loss_win
                if self.stats_size:
                    nev = t["nev"][idx]
                    kl_a = self.adapt_kl(t["x"][idx], t["seg"][idx], t["mask"][idx], logp_all)
                    loss = loss + h.adapt_beta * (self.adapt_weight(nev) * kl_a).mean()
                    with torch.no_grad():
                        stats["kl_adapt"].append(kl_a.mean().item())
                        for name, sel in (("n0", nev == 0), ("n1_2", (nev >= 1) & (nev <= 2)), ("n3p", nev >= 3)):
                            k = int(sel.sum().item())
                            if k:
                                buckets[name][0] += float(kl_a[sel].sum().item())
                                buckets[name][1] += k
                self.opt_actor.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.actor.parameters(), h.max_grad_norm)
                self.opt_actor.step()

                v = self.critic(t["xc"][idx])
                loss_v = F.mse_loss(v, ret_t[idx])
                self.opt_critic.zero_grad()
                loss_v.backward()
                nn.utils.clip_grad_norm_(self.critic.parameters(), h.max_grad_norm)
                self.opt_critic.step()

                with torch.no_grad():
                    stats["pi"].append(loss_pi.item())
                    stats["v"].append(loss_v.item())
                    stats["ent"].append(ent.item())
                    stats["kl_old"].append((t["logp"][idx] - logp).mean().item())
                    stats["kl_magnet"].append(kl_m.item())
                    stats["clip"].append(((ratio - 1).abs() > h.clip).float().mean().item())
                    stats["win"].append(loss_win.item())
        var_ret = float(np.var(returns))
        explained = 1 - float(np.var(returns - values)) / var_ret if var_ret > 0 else 0.0
        out = {k: float(np.mean(v)) for k, v in stats.items() if v}
        if self.stats_size:
            for name, (total, count) in buckets.items():
                out[f"kl_adapt_{name}"] = total / count if count else 0.0
        out["explained_variance"] = explained
        out["mean_reward_abs"] = float(np.mean(np.abs(rec["r"][(rec["flags"] & FLAG_DONE) > 0])))
        return out
