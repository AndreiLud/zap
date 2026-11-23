"""A small S3 server for the cycle's local tests, standing in for MinIO (whose image is no longer
published on Docker Hub). Python standard library only; runs as the compose service `minio`.

What it serves, path style only: list buckets, create, head and delete a bucket, list objects (v2,
with prefix and continuation), put, get, head and delete an object. Every request must carry an AWS
Signature Version 4 made with MINIO_ROOT_USER and MINIO_ROOT_PASSWORD (any region), a payload hash
that matches the body, and a time within 15 minutes. Objects live under --data, one data file and
one metadata file per object, named by the SHA-256 of the key.

Usage: python -I s3server.py --data /data --port 9000
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote
from xml.sax.saxutils import escape

MAX_BODY = 110 * 1024 * 1024
MAX_SKEW = 15 * 60
NS = "http://s3.amazonaws.com/doc/2006-03-01/"


class Store:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        self.meta: dict[str, dict[str, dict]] = {}
        root.mkdir(parents=True, exist_ok=True)
        for b in root.iterdir():
            if b.is_dir() and not b.name.startswith("."):
                self.meta[b.name] = {}
                for m in (b / "meta").glob("*.json") if (b / "meta").is_dir() else []:
                    d = json.loads(m.read_text())
                    self.meta[b.name][d["key"]] = d

    @staticmethod
    def _name(key: str) -> str:
        return hashlib.sha256(key.encode()).hexdigest()

    def buckets(self) -> list[str]:
        return sorted(self.meta)

    def create(self, bucket: str) -> bool:
        with self.lock:
            if bucket in self.meta:
                return False
            (self.root / bucket / "meta").mkdir(parents=True, exist_ok=True)
            (self.root / bucket / "data").mkdir(parents=True, exist_ok=True)
            self.meta[bucket] = {}
            return True

    def delete_bucket(self, bucket: str) -> str:
        with self.lock:
            if bucket not in self.meta:
                return "NoSuchBucket"
            if self.meta[bucket]:
                return "BucketNotEmpty"
            for sub in ("meta", "data"):
                d = self.root / bucket / sub
                if d.is_dir():
                    d.rmdir()
            (self.root / bucket).rmdir()
            del self.meta[bucket]
            return ""

    def put(self, bucket: str, key: str, body: bytes, ctype: str, cache: str | None) -> dict:
        n = self._name(key)
        d = {"key": key, "etag": hashlib.md5(body).hexdigest(), "size": len(body), "contentType": ctype, "cacheControl": cache, "modified": time.time()}
        with self.lock:
            data = self.root / bucket / "data" / n
            tmp = data.with_name(n + ".tmp")
            tmp.write_bytes(body)
            os.replace(tmp, data)
            (self.root / bucket / "meta" / f"{n}.json").write_text(json.dumps(d))
            self.meta[bucket][key] = d
        return d

    def get(self, bucket: str, key: str) -> tuple[dict, bytes] | None:
        with self.lock:
            d = self.meta.get(bucket, {}).get(key)
            if d is None:
                return None
            return d, (self.root / bucket / "data" / self._name(key)).read_bytes()

    def head(self, bucket: str, key: str) -> dict | None:
        with self.lock:
            return self.meta.get(bucket, {}).get(key)

    def delete(self, bucket: str, key: str) -> None:
        n = self._name(key)
        with self.lock:
            if self.meta.get(bucket, {}).pop(key, None) is not None:
                (self.root / bucket / "data" / n).unlink(missing_ok=True)
                (self.root / bucket / "meta" / f"{n}.json").unlink(missing_ok=True)

    def keys(self, bucket: str, prefix: str) -> list[dict]:
        with self.lock:
            return sorted((d for k, d in self.meta[bucket].items() if k.startswith(prefix)), key=lambda d: d["key"])


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def canonical_query(raw: str) -> str:
    pairs = []
    for part in raw.split("&") if raw else []:
        k, _, v = part.partition("=")
        pairs.append((quote(unquote(k), safe="-_.~"), quote(unquote(v), safe="-_.~")))
    return "&".join(f"{k}={v}" for k, v in sorted(pairs))


def check_signature(method: str, raw_path: str, raw_query: str, headers, body_hash: str, user: str, secret: str, now: float) -> str | None:
    """None when the request is signed with the server's credentials; otherwise the error code."""
    auth = headers.get("Authorization", "")
    if not auth.startswith("AWS4-HMAC-SHA256 "):
        return "AccessDenied"
    fields = dict(p.strip().split("=", 1) for p in auth[len("AWS4-HMAC-SHA256 ") :].split(",") if "=" in p)
    cred = fields.get("Credential", "").split("/")
    if len(cred) != 5 or cred[4] != "aws4_request" or cred[3] != "s3":
        return "AuthorizationHeaderMalformed"
    if not hmac.compare_digest(cred[0], user):
        return "InvalidAccessKeyId"
    amz_date = headers.get("x-amz-date", "")
    try:
        t = datetime.strptime(amz_date, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return "AccessDenied"
    if abs(now - t) > MAX_SKEW or amz_date[:8] != cred[1]:
        return "RequestTimeTooSkewed"
    claimed = headers.get("x-amz-content-sha256", "")
    if claimed != "UNSIGNED-PAYLOAD" and claimed != body_hash:
        return "XAmzContentSHA256Mismatch"
    signed = fields.get("SignedHeaders", "").split(";")
    if "host" not in signed:
        return "AccessDenied"
    canon_headers = "".join(f"{h}:{' '.join((headers.get(h) or '').split())}\n" for h in signed)
    creq = "\n".join([method, raw_path, canonical_query(raw_query), canon_headers, ";".join(signed), claimed])
    scope = "/".join(cred[1:])
    sts = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(creq.encode()).hexdigest()])
    k = _hmac(("AWS4" + secret).encode(), cred[1])
    for part in cred[2:]:
        k = _hmac(k, part)
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    return None if hmac.compare_digest(sig, fields.get("Signature", "")) else "SignatureDoesNotMatch"


STATUS = {"NoSuchKey": 404, "NoSuchBucket": 404, "BucketAlreadyOwnedByYou": 409, "BucketNotEmpty": 409, "InvalidBucketName": 400, "EntityTooLarge": 400, "InvalidRequest": 400, "MethodNotAllowed": 405}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "zap-devs3"
    store: Store
    user = ""
    secret = ""

    def log_message(self, fmt, *args):  # one short line per request, no headers
        sys.stderr.write(f"{self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

    def _send(self, code: int, body: bytes = b"", headers: dict | None = None, head: bool = False) -> None:
        headers = dict(headers or {})
        length = headers.pop("Content-Length", None)
        self.send_response(code)
        for k, v in headers.items():
            if v is not None:
                self.send_header(k, v)
        self.send_header("Content-Length", length if head and length is not None else str(len(body)))
        self.end_headers()
        if body and not head:
            self.wfile.write(body)

    def _error(self, code: str, status: int | None = None) -> None:
        st = status or STATUS.get(code, 403)
        body = f'<?xml version="1.0" encoding="UTF-8"?><Error><Code>{code}</Code><Message>{code}</Message></Error>'.encode()
        self._send(st, b"" if self.command == "HEAD" else body, {"Content-Type": "application/xml"})

    def _handle(self) -> None:
        raw_path, _, raw_query = self.path.partition("?")
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._error("EntityTooLarge")
            self.close_connection = True
            return
        body = self.rfile.read(length) if length else b""
        err = check_signature(self.command, raw_path, raw_query, self.headers, hashlib.sha256(body).hexdigest(), self.user, self.secret, time.time())
        if err:
            return self._error(err, 403 if err != "AuthorizationHeaderMalformed" else 400)
        parts = unquote(raw_path).lstrip("/").split("/", 1)
        bucket = parts[0]
        key = parts[1] if len(parts) > 1 else ""
        query = dict((unquote(k), unquote(v)) for k, _, v in (p.partition("=") for p in raw_query.split("&") if p))
        if not bucket:
            if self.command != "GET":
                return self._error("MethodNotAllowed")
            items = "".join(f"<Bucket><Name>{escape(b)}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>" for b in self.store.buckets())
            xml = f'<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="{NS}"><Owner><ID>local</ID></Owner><Buckets>{items}</Buckets></ListAllMyBucketsResult>'
            return self._send(200, xml.encode(), {"Content-Type": "application/xml"})
        if not key:
            return self._bucket(bucket, query)
        if bucket not in self.store.meta:
            return self._error("NoSuchBucket")
        if self.command == "PUT":
            d = self.store.put(bucket, key, body, self.headers.get("Content-Type") or "application/octet-stream", self.headers.get("Cache-Control"))
            return self._send(200, b"", {"ETag": f'"{d["etag"]}"'})
        if self.command in ("GET", "HEAD"):
            if self.command == "HEAD":
                d = self.store.head(bucket, key)
                data = b""
            else:
                got = self.store.get(bucket, key)
                d, data = got if got else (None, b"")
            if d is None:
                return self._error("NoSuchKey")
            hdr = {"ETag": f'"{d["etag"]}"', "Content-Type": d["contentType"], "Cache-Control": d.get("cacheControl"), "Last-Modified": formatdate(d["modified"], usegmt=True)}
            if self.headers.get("If-None-Match", "").strip('"') == d["etag"]:
                return self._send(304, b"", hdr)
            if self.command == "HEAD":
                return self._send(200, b"", {**hdr, "Content-Length": str(d["size"])}, head=True)
            return self._send(200, data, hdr)
        if self.command == "DELETE":
            self.store.delete(bucket, key)
            return self._send(204)
        return self._error("MethodNotAllowed")

    def _bucket(self, bucket: str, query: dict) -> None:
        if self.command == "PUT":
            if not (3 <= len(bucket) <= 63 and all(c.islower() or c.isdigit() or c == "-" for c in bucket)):
                return self._error("InvalidBucketName")
            return self._send(200) if self.store.create(bucket) else self._error("BucketAlreadyOwnedByYou")
        if bucket not in self.store.meta:
            return self._error("NoSuchBucket")
        if self.command == "HEAD":
            return self._send(200)
        if self.command == "DELETE":
            e = self.store.delete_bucket(bucket)
            return self._error(e) if e else self._send(204)
        if self.command != "GET":
            return self._error("MethodNotAllowed")
        if query.get("list-type") != "2":
            return self._error("InvalidRequest")
        prefix = query.get("prefix", "")
        start = query.get("continuation-token") or query.get("start-after") or ""
        limit = max(1, min(1000, int(query.get("max-keys") or 1000)))
        keys = [d for d in self.store.keys(bucket, prefix) if d["key"] > start]
        page, more = keys[:limit], len(keys) > limit
        items = "".join(
            f"<Contents><Key>{escape(d['key'])}</Key><LastModified>{datetime.fromtimestamp(d['modified'], timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')}</LastModified>"
            f"<ETag>&quot;{d['etag']}&quot;</ETag><Size>{d['size']}</Size><StorageClass>STANDARD</StorageClass></Contents>"
            for d in page
        )
        nxt = f"<NextContinuationToken>{escape(page[-1]['key'])}</NextContinuationToken>" if more else ""
        xml = (
            f'<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="{NS}"><Name>{escape(bucket)}</Name><Prefix>{escape(prefix)}</Prefix>'
            f"<KeyCount>{len(page)}</KeyCount><MaxKeys>{limit}</MaxKeys><IsTruncated>{'true' if more else 'false'}</IsTruncated>{nxt}{items}</ListBucketResult>"
        )
        return self._send(200, xml.encode(), {"Content-Type": "application/xml"})

    def do_GET(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def do_DELETE(self):
        self._handle()

    def do_POST(self):
        self._error("MethodNotAllowed")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--port", type=int, default=9000)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    user, secret = os.environ.get("MINIO_ROOT_USER", ""), os.environ.get("MINIO_ROOT_PASSWORD", "")
    if len(user) < 3 or len(secret) < 8:
        sys.exit("set MINIO_ROOT_USER (3 characters or more) and MINIO_ROOT_PASSWORD (8 or more) in .env")
    Handler.store = Store(Path(args.data))
    Handler.user, Handler.secret = user, secret
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    # As PID 1 in its container the server gets no default SIGTERM action: stop on it explicitly.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    sys.stderr.write(f"local S3 stand-in on port {args.port}, data in {args.data}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
