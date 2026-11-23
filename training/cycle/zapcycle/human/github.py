"""Attaches an open data package to a GitHub release (contract 3.11), with the fine-grained token
GITHUB_RELEASES_TOKEN (Contents: read and write, this repository only).

Requests: look up the release of the tag; create it when missing; upload the zip as an asset when
the release does not hold it yet. A dry run prints the same requests (to stderr), with the token replaced by
***, and opens no connection; the local profiles, a test package and a switched off layer always
get a dry run."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Callable
from urllib.parse import quote

from ..errors import CycleError, GuardError

API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAG = re.compile(r"^open-data-\d{8}-\d{4}$")

# (method, url, headers, body) -> (status, json body)
Sender = Callable[[str, str, dict, bytes | None], tuple[int, dict]]


def headers(token: str, content_type: str | None = None) -> dict:
    h = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "zap-cycle"}
    if content_type:
        h["Content-Type"] = content_type
    return h


def shown(h: dict) -> dict:
    return {k: ("Bearer ***" if k == "Authorization" else v) for k, v in h.items()}


class DryRun:
    """Prints each request and answers as if the release did not exist yet; never connects. It prints
    to stderr by default: stdout holds the command's one JSON object (--json), which lists the same
    requests."""

    def __init__(self, out=None):
        self.out = out or sys.stderr
        self.requests: list[dict] = []

    def __call__(self, method: str, url: str, hdrs: dict, body: bytes | None) -> tuple[int, dict]:
        req = {"method": method, "url": url, "headers": shown(hdrs), "bodyBytes": 0 if body is None else len(body)}
        if body is not None and hdrs.get("Content-Type") == "application/json":
            req["body"] = json.loads(body)
        self.requests.append(req)
        print("dry run: " + json.dumps(req), file=self.out)
        if method == "GET":
            return 404, {"message": "Not Found"}
        if url.startswith(API):
            return 201, {"id": 0, "upload_url": f"{UPLOADS}/repos/OWNER/REPO/releases/0/assets{{?name,label}}", "assets": []}
        return 201, {"id": 0, "name": url.rsplit("=", 1)[-1]}


def http_sender(method: str, url: str, hdrs: dict, body: bytes | None) -> tuple[int, dict]:
    """The real requests (production only)."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
            return r.status, json.loads(data) if data else {}
    except urllib.error.HTTPError as e:
        data = e.read()
        try:
            return e.code, json.loads(data) if data else {}
        except ValueError:
            return e.code, {}


def publish_release(repo: str, tag: str, title: str, notes: str, zip_path: Path, token: str, send: Sender) -> dict:
    if not REPO.match(repo or ""):
        raise CycleError("[human.open_data] repo must be OWNER/NAME")
    if not TAG.match(tag):
        raise CycleError(f"unexpected release tag {tag}")
    if not token:
        raise GuardError("GITHUB_RELEASES_TOKEN is not set")
    status, rel = send("GET", f"{API}/repos/{repo}/releases/tags/{quote(tag)}", headers(token), None)
    created = False
    if status == 404:
        body = json.dumps({"tag_name": tag, "name": title, "body": notes, "draft": False, "prerelease": False, "make_latest": "false"}).encode()
        status, rel = send("POST", f"{API}/repos/{repo}/releases", headers(token, "application/json"), body)
        if status not in (200, 201):
            raise CycleError(f"GitHub did not create the release: HTTP {status}")
        created = True
    elif status != 200:
        raise CycleError(f"GitHub release lookup failed: HTTP {status}")
    name = zip_path.name
    if any(a.get("name") == name for a in rel.get("assets", [])):
        return {"tag": tag, "created": created, "uploaded": False, "asset": name}
    upload = str(rel["upload_url"]).split("{", 1)[0] + f"?name={quote(name)}"
    status, _ = send("POST", upload, headers(token, "application/zip"), zip_path.read_bytes())
    if status not in (200, 201):
        raise CycleError(f"GitHub did not take the asset: HTTP {status}")
    return {"tag": tag, "created": created, "uploaded": True, "asset": name}
