import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from zapcycle.config import ROOT
from zapcycle.lock import cycle_lock

from .helpers import CONFIG_DIR


def temp_toml(profile: str) -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp())
    text = (CONFIG_DIR / f"{profile}.toml").read_text()
    for k in ("data", "work"):
        text = text.replace(f'{k} = "training/cycle/{k}/{profile}"', f'{k} = "{tmp}/{k}"')
    text = text.replace('logs = "training/logs/test"', f'logs = "{tmp}/logs"').replace('logs = "training/logs"', f'logs = "{tmp}/logs"')
    p = tmp / f"{profile}.toml"
    p.write_text(text)
    return p, tmp


def cli(cfg: Path, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1", **(env or {})}
    return subprocess.run([sys.executable, str(ROOT / "training/cycle/cycle.py"), "--config", str(cfg), "--json", *args], capture_output=True, text=True, cwd=ROOT, env=e)


class CliTest(unittest.TestCase):
    def test_exit_codes(self):
        prod, _ = temp_toml("prod")
        r = cli(prod, "run", "--force", "pass")
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertEqual(json.loads(r.stdout)["exitCode"], 2)
        r = cli(prod, "bridge", "push", "--state", "e2e")
        self.assertEqual(r.returncode, 2)
        r = cli(prod, "sync")
        self.assertEqual(r.returncode, 2, "r2 mode without R2_ENDPOINT is refused by a guard")
        test, tmp = temp_toml("test")
        with cycle_lock(tmp / "data", "20261121-2200", 1):
            r = cli(test, "sync")
        self.assertEqual(r.returncode, 3)
        self.assertIn("lock busy", json.loads(r.stdout)["error"])
        r = cli(test, "train")
        self.assertEqual(r.returncode, 1)
        self.assertIn("run build first", json.loads(r.stdout)["error"])

    def test_human_commands_answer_with_the_stub(self):
        test, _ = temp_toml("test")
        r = cli(test, "flags", "list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["result"]["command"], "flags")

    def test_bad_config(self):
        r = cli(Path("/nonexistent.toml"), "status")
        self.assertEqual(r.returncode, 1)
