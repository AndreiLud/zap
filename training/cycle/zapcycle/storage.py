"""S3 storage client for R2 (production) and the local MinIO stand-in (tests), through boto3.

Store(config, role) checks every guard before any network call:
* r2 mode: endpoint from env R2_ENDPOINT on r2.cloudflarestorage.com, bucket names exactly
  zap-events, zap-models, zap-public, keys R2_EVENTS_* (role events) or R2_PUBLISH_* (role publish).
* minio mode: endpoint http://minio:9000, http://127.0.0.1:9000 or http://localhost:9000, every
  bucket name starting with zap-test-, keys MINIO_ROOT_USER and MINIO_ROOT_PASSWORD.
* roles: events (get, head and list on the events bucket), publish (get, head, list, put, delete on
  the models and public buckets), and in minio mode only: bridge (put on the events bucket, read the
  models bucket) and admin (create the profile's buckets). Any other call raises GuardError.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Iterator

from .config import Config
from .errors import CycleError, GuardError

R2_ENDPOINT = re.compile(r"^https://[0-9a-f]{32}\.(eu\.)?r2\.cloudflarestorage\.com$")
MINIO_ENDPOINTS = ("http://minio:9000", "http://127.0.0.1:9000", "http://localhost:9000")
PROD_BUCKETS = {"events": "zap-events", "models": "zap-models", "public": "zap-public"}
TEST_PREFIX = "zap-test-"
KINDS = ("events", "models", "public")

READ = {"get", "head", "list"}
ROLES: dict[str, dict[str, set[str]]] = {
    "events": {"events": READ},
    "publish": {"models": READ | {"put", "delete"}, "public": READ | {"put", "delete"}},
    "bridge": {"events": READ | {"put"}, "models": READ},
    "admin": {"events": {"create"}, "models": {"create"}, "public": {"create"}},
}
MINIO_ONLY_ROLES = ("bridge", "admin")
CREDS = {
    ("r2", "events"): ("R2_EVENTS_ACCESS_KEY_ID", "R2_EVENTS_SECRET_ACCESS_KEY"),
    ("r2", "publish"): ("R2_PUBLISH_ACCESS_KEY_ID", "R2_PUBLISH_SECRET_ACCESS_KEY"),
}
MINIO_CREDS = ("MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD")


class TooLarge(CycleError):
    pass


@dataclass
class Obj:
    key: str
    body: bytes
    etag: str
    size: int
    content_type: str | None


@dataclass
class ObjInfo:
    key: str
    size: int
    etag: str


def check_guards(cfg: Config, role: str, env: dict | None = None) -> tuple[str, dict[str, str], tuple[str, str]]:
    """Endpoint, buckets by kind and credential variable names; GuardError on any mix."""
    env = os.environ if env is None else env
    s = cfg.storage
    if role not in ROLES:
        raise GuardError(f"unknown storage role {role}")
    buckets = {k: s[f"{k}_bucket"] for k in KINDS}
    if s["mode"] == "r2":
        if role in MINIO_ONLY_ROLES:
            raise GuardError(f"role {role} exists only in minio mode")
        if s["endpoint"]:
            raise GuardError("r2 mode takes its endpoint from R2_ENDPOINT, not from the config")
        endpoint = env.get("R2_ENDPOINT", "")
        if not R2_ENDPOINT.match(endpoint):
            raise GuardError("R2_ENDPOINT must be https://<account id>.r2.cloudflarestorage.com")
        for k, name in buckets.items():
            if name != PROD_BUCKETS[k]:
                raise GuardError(f"r2 mode needs the bucket {PROD_BUCKETS[k]} for {k}, not {name}")
        creds = CREDS[("r2", role)]
    elif s["mode"] == "minio":
        endpoint = s["endpoint"]
        if endpoint not in MINIO_ENDPOINTS:
            raise GuardError(f"minio mode needs a local endpoint ({', '.join(MINIO_ENDPOINTS)})")
        for k, name in buckets.items():
            if not name.startswith(TEST_PREFIX):
                raise GuardError(f"minio mode needs bucket names starting with {TEST_PREFIX}, not {name}")
        creds = MINIO_CREDS
    else:
        raise GuardError(f"unknown storage mode {s['mode']}")
    if len(set(buckets.values())) != 3:
        raise GuardError("the three buckets must differ")
    return endpoint, buckets, creds


def make_client(endpoint: str, key_id: str, secret: str):
    import boto3
    from botocore.config import Config as BotoConfig

    conf = BotoConfig(
        signature_version="s3v4",
        s3={"addressing_style": "path"},
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
        retries={"mode": "standard", "max_attempts": 5},
        connect_timeout=10,
        read_timeout=120,
    )
    return boto3.session.Session().client("s3", endpoint_url=endpoint, aws_access_key_id=key_id, aws_secret_access_key=secret, region_name="auto", config=conf)


class Store:
    def __init__(self, cfg: Config, role: str, env: dict | None = None, client=None):
        env = os.environ if env is None else env
        self.cfg = cfg
        self.role = role
        self.endpoint, self.buckets, creds = check_guards(cfg, role, env)
        if client is None:
            key_id, secret = env.get(creds[0], ""), env.get(creds[1], "")
            if not key_id or not secret:
                raise CycleError(f"missing credentials: set {creds[0]} and {creds[1]} in .env")
            client = make_client(self.endpoint, key_id, secret)
        self.client = client

    def _allow(self, op: str, kind: str) -> str:
        if op not in ROLES[self.role].get(kind, set()):
            raise GuardError(f"role {self.role} may not {op} on the {kind} bucket")
        return self.buckets[kind]

    @staticmethod
    def _missing(e: Exception) -> bool:
        code = getattr(e, "response", {}).get("Error", {}).get("Code", "")
        return code in ("NoSuchKey", "404", "NotFound", "NoSuchBucket")

    def get(self, kind: str, key: str, max_bytes: int | None = None) -> Obj | None:
        bucket = self._allow("get", kind)
        try:
            r = self.client.get_object(Bucket=bucket, Key=key)
        except Exception as e:
            if self._missing(e):
                return None
            raise
        size = int(r.get("ContentLength", 0))
        if max_bytes is not None and size > max_bytes:
            r["Body"].close()
            raise TooLarge(f"{key}: {size} bytes, over the limit of {max_bytes}")
        body = r["Body"].read()
        if max_bytes is not None and len(body) > max_bytes:
            raise TooLarge(f"{key}: over the limit of {max_bytes} bytes")
        return Obj(key, body, r.get("ETag", "").strip('"'), len(body), r.get("ContentType"))

    def head(self, kind: str, key: str) -> ObjInfo | None:
        bucket = self._allow("head", kind)
        try:
            r = self.client.head_object(Bucket=bucket, Key=key)
        except Exception as e:
            if self._missing(e):
                return None
            raise
        return ObjInfo(key, int(r.get("ContentLength", 0)), r.get("ETag", "").strip('"'))

    def list(self, kind: str, prefix: str) -> list[ObjInfo]:
        return list(self.iter_list(kind, prefix))

    def iter_list(self, kind: str, prefix: str) -> Iterator[ObjInfo]:
        bucket = self._allow("list", kind)
        token = None
        while True:
            kw = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
            if token:
                kw["ContinuationToken"] = token
            r = self.client.list_objects_v2(**kw)
            for o in r.get("Contents", []) or []:
                yield ObjInfo(o["Key"], int(o.get("Size", 0)), str(o.get("ETag", "")).strip('"'))
            if not r.get("IsTruncated"):
                return
            token = r.get("NextContinuationToken")

    def put(self, kind: str, key: str, body: bytes, content_type: str, cache_control: str | None = None) -> str:
        bucket = self._allow("put", kind)
        kw = {"Bucket": bucket, "Key": key, "Body": body, "ContentType": content_type}
        if cache_control:
            kw["CacheControl"] = cache_control
        r = self.client.put_object(**kw)
        return str(r.get("ETag", "")).strip('"')

    def delete(self, kind: str, key: str) -> None:
        bucket = self._allow("delete", kind)
        self.client.delete_object(Bucket=bucket, Key=key)

    def create_buckets(self) -> list[str]:
        """minio mode only (role admin): creates the profile's three buckets when missing."""
        made = []
        for kind in KINDS:
            bucket = self._allow("create", kind)
            try:
                self.client.head_bucket(Bucket=bucket)
                continue
            except Exception as e:
                code = getattr(e, "response", {}).get("Error", {}).get("Code", "")
                if code not in ("404", "NoSuchBucket", "NotFound"):
                    raise
            self.client.create_bucket(Bucket=bucket)
            made.append(bucket)
        return made

    def list_buckets(self) -> list[str]:
        if self.role != "admin":
            raise GuardError("only the admin role lists buckets")
        return [b["Name"] for b in self.client.list_buckets().get("Buckets", [])]

    def bucket(self, kind: str) -> "Bucket":
        return Bucket(self, kind)


class Bucket:
    """One bucket of a Store, for code that works on a single bucket (CycleContext)."""

    def __init__(self, store: Store, kind: str):
        self.store = store
        self.kind = kind

    def get(self, key: str, max_bytes: int | None = None) -> Obj | None:
        return self.store.get(self.kind, key, max_bytes)

    def head(self, key: str) -> ObjInfo | None:
        return self.store.head(self.kind, key)

    def list(self, prefix: str) -> list[ObjInfo]:
        return self.store.list(self.kind, prefix)

    def put(self, key: str, body: bytes, content_type: str, cache_control: str | None = None) -> str:
        return self.store.put(self.kind, key, body, content_type, cache_control)

    def delete(self, key: str) -> None:
        self.store.delete(self.kind, key)


JSON_TYPE = "application/json; charset=utf-8"
MODEL_TYPE = "application/octet-stream"
SUMMARY_CACHE = "public, max-age=300"
