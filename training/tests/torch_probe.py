"""Records whether PyTorch runs on this machine's CPU (the server has no AVX) in facts.json.

  docker compose run --rm -T train python training/tests/torch_probe.py
"""

import json
import platform
import time
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[2]
x = torch.randn(256, 431)
net = torch.nn.Sequential(torch.nn.Linear(431, 256), torch.nn.ReLU(), torch.nn.Linear(256, 15))
loss = net(x).pow(2).mean()
loss.backward()
flags = ""
try:
    flags = next(l for l in open("/proc/cpuinfo") if l.startswith("flags"))
except Exception:
    pass
facts_path = ROOT / "facts.json"
facts = json.loads(facts_path.read_text()) if facts_path.exists() else {}
facts.setdefault("training", {})["torch"] = {
    "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "torch": torch.__version__,
    "cpuCapability": torch.backends.cpu.get_cpu_capability(),
    "cpuHasAvx": " avx " in flags or flags.rstrip().endswith(" avx"),
    "machine": platform.machine(),
    "forwardBackwardOk": bool(torch.isfinite(loss).item()),
}
facts_path.write_text(json.dumps(facts, indent=2) + "\n")
print(json.dumps(facts["training"]["torch"]))
