"""Shared runtime of the commands: config, log, state, stores by role, the remote status file,
the manifest and cards, version numbers and the local version folders."""

from __future__ import annotations

import json
import logging
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import formats
from .config import ROOT, Config
from .errors import CycleError, FormatError
from .state import State, load_state, version_number, write_json_atomic
from .storage import JSON_TYPE, MODEL_TYPE, Bucket, Store

# v1, the first bundled model: a fixed member of the gate panel and the base of the human model.
BUNDLED_MODEL = "ai/models/bootstrap/zap-v1.zapw"
BUNDLED_MANIFEST = "ai/models/bootstrap/manifest.json"
# Every model shipped in the Worker bundle (worker/src/cf/ai-runtime.ts), oldest first. init uploads
# the ones the profile lists in storage.bundled and makes the last of them current. card: the model
# card written when the version was gated (None: a bootstrap card from the manifest); snapshot,
# args and checkpoint: the training run behind it, copied to versions/vN/ when present, so the next
# candidate starts from them.
BUNDLE: dict[str, dict[str, str | None]] = {
    "v1": {
        "model": BUNDLED_MODEL,
        "manifest": BUNDLED_MANIFEST,
        "card": None,
        "snapshot": "training/runs/main/league/it000150.zapw",
        "args": "training/runs/main/args.json",
        "checkpoint": None,
    },
    "v2": {
        "model": "ai/models/bootstrap/zap-v2.zapw",
        "manifest": "ai/models/bootstrap/manifest-v2.json",
        "card": "ai/models/bootstrap/card-v2.json",
        "snapshot": "training/runs/m6-twin/league/it000390.zapw",
        "args": "training/runs/m6-twin/args.json",
        "checkpoint": "training/runs/m6-twin/checkpoint.pt",
    },
}
STATUS_KEY = "status/training.json"
MANIFEST_KEY = "manifest.json"
SUMMARY_KEY = "summary.json"


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ms: int | None) -> str | None:
    return None if ms is None else datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def new_cycle_id(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y%m%d-%H%M")


def rel(p) -> str:
    """A path relative to the project root when it lies inside it (cards and specs carry no server paths)."""
    q = Path(p)
    try:
        return str(q.resolve().relative_to(ROOT))
    except ValueError:
        return str(q)


def model_key(v: str) -> str:
    return f"models/{v}.zapw"


def card_key(v: str) -> str:
    return f"cards/{v}.json"


def plain(msg: str, limit: int = 500) -> str:
    """A status message: printable, one line, at most `limit` characters."""
    s = " ".join("".join(ch if ch.isprintable() else " " for ch in str(msg)).split())
    return s[:limit]


class Cycle:
    """One command's view of a profile. Tests pass stores (role to Store) and a clock."""

    def __init__(self, cfg: Config, log: logging.Logger | None = None, stores: dict[str, Store] | None = None, clock: Callable[[], int] | None = None, env: dict | None = None):
        self.cfg = cfg
        self.log = log or logging.getLogger("zapcycle")
        self.env = os.environ if env is None else env
        self._stores: dict[str, Store] = dict(stores or {})
        self.clock = clock or now_ms
        self.state: State = load_state(cfg.data_dir)
        cfg.data_dir.mkdir(parents=True, exist_ok=True)

    # Storage -----------------------------------------------------------------------------------

    def store(self, role: str) -> Store:
        if role not in self._stores:
            self._stores[role] = Store(self.cfg, role, self.env)
        return self._stores[role]

    def bucket(self, role: str, kind: str) -> Bucket:
        return self.store(role).bucket(kind)

    @property
    def models(self) -> Bucket:
        return self.bucket("publish", "models")

    @property
    def public(self) -> Bucket:
        return self.bucket("publish", "public")

    @property
    def events(self) -> Bucket:
        return self.bucket("events", "events")

    def get_json(self, bucket: Bucket, key: str, schema: str) -> dict | None:
        obj = bucket.get(key, formats.SIZE_LIMITS[schema])
        return None if obj is None else formats.load(schema, obj.body)

    def put_json(self, bucket: Bucket, key: str, schema: str, value: dict, cache_control: str | None = None) -> None:
        formats.check(schema, value)
        bucket.put(key, formats.dumps(value), JSON_TYPE, cache_control)

    # Manifest, cards, versions ------------------------------------------------------------------

    def manifest(self) -> dict | None:
        return self.get_json(self.models, MANIFEST_KEY, "zap-manifest/1")

    def require_manifest(self) -> dict:
        m = self.manifest()
        if m is None:
            raise CycleError("no manifest.json in the models bucket: run init first")
        return m

    @property
    def cards_dir(self) -> Path:
        return self.cfg.data_dir / "cards"

    def card(self, v: str) -> dict | None:
        """A model card, from the local copy or the bucket (then kept locally)."""
        local = self.cards_dir / f"{v}.json"
        if local.exists():
            return json.loads(local.read_text())
        c = self.get_json(self.models, card_key(v), "zap-card/1")
        if c is not None:
            write_json_atomic(local, c)
        return c

    def put_card(self, card: dict) -> None:
        self.put_json(self.models, card_key(card["version"]), "zap-card/1", card)
        write_json_atomic(self.cards_dir / f"{card['version']}.json", card)

    def next_version(self, manifest: dict) -> str:
        """Largest of the manifest's models, the cards in the bucket and the numbers already taken, plus 1."""
        nums = [version_number(v) for v in manifest["models"]]
        for o in self.models.list("cards/"):
            name = o.key.rsplit("/", 1)[-1]
            if name.startswith("v") and name.endswith(".json") and name[1:-5].isdigit():
                nums.append(int(name[1:-5]))
        nums.append(int(self.state.get("lastVersionNumber") or 1))
        n = max(nums) + 1
        self.state["lastVersionNumber"] = n
        self.state.save()
        return f"v{n}"

    def version_dir(self, v: str) -> Path:
        return self.cfg.data_dir / "versions" / v

    def ensure_version(self, v: str, entry: dict) -> Path:
        """Local copy of a version's served file (models/vN.zapw), checked against its manifest entry."""
        d = self.version_dir(v)
        f = d / "model.zapw"
        if f.exists() and sha256_file(f) == entry["sha256"]:
            return d
        bundled = next((ROOT / b["model"] for b in BUNDLE.values() if (ROOT / b["model"]).exists() and sha256_file(ROOT / b["model"]) == entry["sha256"]), None)
        if bundled is not None:
            data = bundled.read_bytes()
        else:
            obj = self.models.get(model_key(v), formats.MAX_MODEL_BYTES)
            if obj is None:
                raise CycleError(f"{model_key(v)} is missing from the models bucket")
            data = obj.body
        if sha256_bytes(data) != entry["sha256"]:
            raise CycleError(f"{model_key(v)} does not match the SHA-256 of the manifest")
        d.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        return d

    def promoted(self) -> list[str]:
        """Promoted versions, oldest first (state.promotions; without it, the manifest's models after v1)."""
        p = [x["version"] for x in self.state.get("promotions", [])]
        if p:
            return p
        m = self.manifest()
        return sorted((v for v in (m or {}).get("models", {}) if v != "v1"), key=version_number)

    # Status -------------------------------------------------------------------------------------

    def read_status(self) -> dict | None:
        try:
            return self.get_json(self.models, STATUS_KEY, "zap-status/1")
        except FormatError:
            return None

    def write_status(self, state: str, step: str, message: str, cycle_id: str | None = None, started_at: int | None = None, finished_at: int | None = None, last_promotion: dict | None = None, keep_failed: bool = True) -> dict:
        """Writes status/training.json. A failed state stays while a later cycle runs, until one ends ok."""
        prev = self.read_status() or {}
        if keep_failed and state == "running" and prev.get("state") == "failed":
            state = "failed"
        s = {
            "schema": "zap-status/1",
            "state": state,
            "startedAt": started_at if started_at is not None else prev.get("startedAt"),
            "finishedAt": finished_at if finished_at is not None else prev.get("finishedAt"),
            "updatedAt": self.clock(),
            "cycleId": cycle_id if cycle_id is not None else prev.get("cycleId"),
            "step": step,
            "lastPromotion": last_promotion if last_promotion is not None else prev.get("lastPromotion"),
            "message": plain(message),
        }
        self.put_json(self.models, STATUS_KEY, "zap-status/1", s)
        return s

    def touch_status(self) -> dict | None:
        """The scheduler's daily check: updatedAt moves, everything else stays."""
        prev = self.read_status()
        if prev is None:
            return None
        return self.restore_status(prev)

    def restore_status(self, earlier: dict) -> dict:
        """Writes a status read earlier again as it was (state, step, message, cycleId, startedAt,
        finishedAt, lastPromotion), with a fresh updatedAt."""
        s = {**earlier, "updatedAt": self.clock()}
        self.put_json(self.models, STATUS_KEY, "zap-status/1", s)
        return s

    # Work folders -------------------------------------------------------------------------------

    def work(self, cycle_id: str) -> Path:
        d = self.cfg.work_dir / cycle_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def latest_work(self) -> str:
        if not self.cfg.work_dir.is_dir():
            raise CycleError("no cycle work folder yet: run build first, or pass --cycle")
        ids = sorted(p.name for p in self.cfg.work_dir.iterdir() if p.is_dir() and len(p.name) == 13)
        if not ids:
            raise CycleError("no cycle work folder yet: run build first, or pass --cycle")
        return ids[-1]

    def prune_work(self) -> list[str]:
        """Keeps the newest keep_cycles work folders. Of every one but the newest, the per person
        tables go as well (tables/ and human/ hold group tokens of their export, and one style
        reading per group); their card, gate, training runs and human/result.json stay."""
        keep = int(self.cfg.paths["keep_cycles"])
        if not self.cfg.work_dir.is_dir():
            return []
        ids = sorted(p.name for p in self.cfg.work_dir.iterdir() if p.is_dir() and len(p.name) == 13)
        gone = ids[: max(0, len(ids) - keep)]
        for i in gone:
            shutil.rmtree(self.cfg.work_dir / i, ignore_errors=True)
        for i in ids[len(gone) : -1]:
            strip_people(self.cfg.work_dir / i)
        return gone


def strip_people(work: Path) -> None:
    """Removes what is keyed by a group token from a finished cycle's work folder."""
    shutil.rmtree(work / "tables", ignore_errors=True)
    human = work / "human"
    if human.is_dir():
        for p in human.iterdir():
            if p.name == "result.json":
                continue
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)


def sha256_bytes(b: bytes) -> str:
    import hashlib

    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def zapw_header(path: Path) -> dict:
    """The JSON header of a ZAPW file (ai/src/mlp.ts layout: magic, version, header length)."""
    import struct

    b = Path(path).read_bytes()
    magic, version, hlen = struct.unpack_from("<III", b, 0)
    if magic != 0x5750415A or version != 1:
        raise CycleError(f"{path}: not a Zap model file")
    return json.loads(b[12 : 12 + hlen].decode())


def git_commit(root: Path = ROOT) -> str | None:
    """The commit of the working tree, read from .git/HEAD and the ref it names (never by running git)."""
    try:
        head = (root / ".git" / "HEAD").read_text().strip()
        if not head.startswith("ref: "):
            return head or None
        ref = head[5:]
        f = root / ".git" / ref
        if f.exists():
            return f.read_text().strip() or None
        packed = root / ".git" / "packed-refs"
        if packed.exists():
            for line in packed.read_text().splitlines():
                if line.endswith(" " + ref):
                    return line.split(" ")[0]
    except OSError:
        return None
    return None


def write_json(path: Path, value: Any) -> None:
    write_json_atomic(path, value)


def read_json(path: Path) -> Any:
    return json.loads(Path(path).read_text())


MODEL_CT = MODEL_TYPE
