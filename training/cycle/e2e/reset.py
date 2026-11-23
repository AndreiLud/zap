"""Empties a local profile before an end to end run: every object of its three buckets on the S3
stand-in, and its data and work folders. Refuses anything but minio mode and zap-test- buckets.

Usage (cycle container): python training/cycle/e2e/reset.py --config training/cycle/config/test.toml
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from zapcycle.config import ROOT, load_config  # noqa: E402
from zapcycle.storage import check_guards, make_client  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    cfg = load_config(ap.parse_args().config)
    if cfg.mode != "minio" or cfg.profile == "prod":
        sys.exit("reset works only on a local minio profile")
    endpoint, buckets, _ = check_guards(cfg, "admin")
    client = make_client(endpoint, os.environ["MINIO_ROOT_USER"], os.environ["MINIO_ROOT_PASSWORD"])
    existing = {b["Name"] for b in client.list_buckets().get("Buckets", [])}
    removed = 0
    for name in buckets.values():
        if not name.startswith("zap-test-") or name not in existing:
            continue
        while True:
            objs = client.list_objects_v2(Bucket=name).get("Contents", []) or []
            if not objs:
                break
            for o in objs:
                client.delete_object(Bucket=name, Key=o["Key"])
                removed += 1
    for d in (cfg.data_dir, cfg.work_dir):
        allowed = (ROOT / "training" / "cycle" / "data", ROOT / "training" / "cycle" / "work")
        if d.exists() and any(d.resolve().is_relative_to(a) for a in allowed):
            shutil.rmtree(d)
    print(json.dumps({"profile": cfg.profile, "objectsRemoved": removed}))


if __name__ == "__main__":
    main()
