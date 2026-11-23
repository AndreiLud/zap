"""Shared pieces of the cycle's unit tests: configs in temporary folders, an in-memory S3 client
with the boto3 method names the Store uses, and the reachability check of the local S3 stand-in."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import socket
import tempfile
from pathlib import Path

from zapcycle.config import ROOT, load_config
from zapcycle.core import Cycle
from zapcycle.storage import Store

CONFIG_DIR = ROOT / "training" / "cycle" / "config"
R2_ENV = {
    "R2_ENDPOINT": "https://" + "0123456789abcdef" * 2 + ".r2.cloudflarestorage.com",
    "R2_EVENTS_ACCESS_KEY_ID": "events-key-id",
    "R2_EVENTS_SECRET_ACCESS_KEY": "events-secret-value",
    "R2_PUBLISH_ACCESS_KEY_ID": "publish-key-id",
    "R2_PUBLISH_SECRET_ACCESS_KEY": "publish-secret-value",
}
MINIO_ENV = {"MINIO_ROOT_USER": "unit-user", "MINIO_ROOT_PASSWORD": "unit-password-123"}


def temp_config(profile: str = "test", **sections):
    """A profile's config with data, work and logs in a new temporary folder."""
    tmp = Path(tempfile.mkdtemp(prefix=f"zapcycle-{profile}-"))
    cfg = load_config(CONFIG_DIR / f"{profile}.toml", env={}).with_paths(tmp / "data", tmp / "work", tmp / "logs")
    for name, values in sections.items():
        cfg = cfg.with_values(name, **values)
    return cfg, tmp


class FakeError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    """Buckets in memory; `calls` keeps (operation, bucket, key) in order."""

    def __init__(self, buckets: dict[str, dict] | None = None):
        self.buckets: dict[str, dict[str, dict]] = buckets if buckets is not None else {}
        self.calls: list[tuple[str, str, str]] = []

    def _b(self, bucket: str) -> dict:
        if bucket not in self.buckets:
            raise FakeError("NoSuchBucket")
        return self.buckets[bucket]

    def create_bucket(self, Bucket):
        self.calls.append(("create", Bucket, ""))
        self.buckets.setdefault(Bucket, {})

    def head_bucket(self, Bucket):
        self.calls.append(("head_bucket", Bucket, ""))
        if Bucket not in self.buckets:
            raise FakeError("404")

    def list_buckets(self):
        return {"Buckets": [{"Name": b} for b in sorted(self.buckets)]}

    def put_object(self, Bucket, Key, Body, ContentType, CacheControl=None):
        self.calls.append(("put", Bucket, Key))
        etag = hashlib.md5(Body).hexdigest()
        self._b(Bucket)[Key] = {"body": bytes(Body), "etag": etag, "type": ContentType, "cache": CacheControl}
        return {"ETag": f'"{etag}"'}

    def get_object(self, Bucket, Key):
        self.calls.append(("get", Bucket, Key))
        o = self._b(Bucket).get(Key)
        if o is None:
            raise FakeError("NoSuchKey")

        class Body:
            def __init__(self, b):
                self.b = b

            def read(self):
                return self.b

            def close(self):
                pass

        return {"Body": Body(o["body"]), "ETag": f'"{o["etag"]}"', "ContentLength": len(o["body"]), "ContentType": o["type"]}

    def head_object(self, Bucket, Key):
        o = self._b(Bucket).get(Key)
        if o is None:
            raise FakeError("404")
        return {"ETag": f'"{o["etag"]}"', "ContentLength": len(o["body"])}

    def list_objects_v2(self, Bucket, Prefix="", MaxKeys=1000, ContinuationToken=None):
        self.calls.append(("list", Bucket, Prefix))
        keys = sorted(k for k in self._b(Bucket) if k.startswith(Prefix) and (ContinuationToken is None or k > ContinuationToken))
        page = keys[:MaxKeys]
        out = {"Contents": [{"Key": k, "Size": len(self.buckets[Bucket][k]["body"]), "ETag": f'"{self.buckets[Bucket][k]["etag"]}"'} for k in page], "IsTruncated": len(keys) > MaxKeys}
        if out["IsTruncated"]:
            out["NextContinuationToken"] = page[-1]
        return out

    def delete_object(self, Bucket, Key):
        self.calls.append(("delete", Bucket, Key))
        self._b(Bucket).pop(Key, None)

    def json(self, bucket: str, key: str):
        return json.loads(self.buckets[bucket][key]["body"])


def fake_cycle(cfg, s3: FakeS3 | None = None, clock=None) -> tuple[Cycle, FakeS3]:
    """A Cycle whose four roles share one in-memory S3, with the profile's buckets made."""
    s3 = s3 or FakeS3()
    env = MINIO_ENV if cfg.mode == "minio" else R2_ENV
    for kind in ("events", "models", "public"):
        s3.buckets.setdefault(cfg.storage[f"{kind}_bucket"], {})
    roles = ("events", "publish", "bridge", "admin") if cfg.mode == "minio" else ("events", "publish")
    stores = {r: Store(cfg, r, env=env, client=s3) for r in roles}
    log = logging.getLogger("zapcycle.test")
    log.addHandler(logging.NullHandler())
    log.propagate = False
    return Cycle(cfg, log, stores=stores, clock=clock), s3


def minio_up(host: str = "minio", port: int = 9000) -> bool:
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


MINIO_DOWN = "the local S3 stand-in is not running: docker compose --profile cycle-dev up -d minio"


def have_minio_env() -> bool:
    return bool(os.environ.get("MINIO_ROOT_USER") and os.environ.get("MINIO_ROOT_PASSWORD"))
