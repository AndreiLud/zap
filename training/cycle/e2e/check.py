"""Checks of the local end to end runs, each printing one JSON line and exiting 1 on failure.

  setups CYCLE_DIR                 the candidate's metrics.jsonl counted snapshot opponents
  manifest CURRENT CONTROL|none    current and control of the profile's manifest
  listing                          only zap-test- buckets exist, every record is marked test
  arms STATE NEW OLD               records of the local site after the last promotion: the new
                                   version only on opponent seats, both arms present
  plays STATE VERSION              the newest record of the local site was played by VERSION
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from zapcycle.config import load_config  # noqa: E402
from zapcycle.storage import check_guards, make_client  # noqa: E402


def fail(msg: str, **extra) -> None:
    print(json.dumps({"ok": False, "error": msg, **extra}))
    sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("what", choices=["setups", "manifest", "listing", "arms", "plays"])
    ap.add_argument("args", nargs="*")
    a = ap.parse_args()
    cfg = load_config(a.config)
    if a.what == "setups":
        work = Path(a.args[0]) if a.args else sorted(p for p in cfg.work_dir.iterdir() if p.is_dir())[-1]
        setups: dict[str, int] = {}
        for line in (work / "runs" / "candidate" / "metrics.jsonl").read_text().splitlines():
            for k, v in (json.loads(line).get("setups") or {}).items():
                setups[k] = setups.get(k, 0) + v
        need = ["snapshots", "v1", "tuned", "base", "random", "characters"]
        missing = [k for k in need if not setups.get(k)]
        if missing:
            fail("opponent kinds missing from the training setups", missing=missing, setups=setups)
        print(json.dumps({"ok": True, "setups": setups}))
        return
    if a.what in ("arms", "plays"):
        return site_records(cfg, a.what, a.args)
    endpoint, buckets, creds = check_guards(cfg, "admin")
    client = make_client(endpoint, os.environ[creds[0]], os.environ[creds[1]])
    if a.what == "manifest":
        m = json.loads(client.get_object(Bucket=buckets["models"], Key="manifest.json")["Body"].read())
        want_control = None if a.args[1] == "none" else a.args[1]
        if m["current"] != a.args[0] or m["control"] != want_control:
            fail("unexpected manifest", current=m["current"], control=m["control"])
        print(json.dumps({"ok": True, "current": m["current"], "control": m["control"], "models": sorted(m["models"])}))
        return
    names = [b["Name"] for b in client.list_buckets().get("Buckets", [])]
    bad = [n for n in names if not n.startswith("zap-test-")]
    if bad:
        fail("a bucket outside zap-test-", buckets=bad)
    records = not_test = 0
    token = None
    while True:
        kw = {"Bucket": buckets["events"], "Prefix": "matches/"}
        if token:
            kw["ContinuationToken"] = token
        r = client.list_objects_v2(**kw)
        for o in r.get("Contents", []) or []:
            records += 1
            body = json.loads(client.get_object(Bucket=buckets["events"], Key=o["Key"])["Body"].read())
            if body.get("test") is not True:
                not_test += 1
        if not r.get("IsTruncated"):
            break
        token = r["NextContinuationToken"]
    if not_test:
        fail("records without the test mark", records=records, notTest=not_test)
    print(json.dumps({"ok": True, "buckets": names, "records": records, "allTest": True}))


def site_records(cfg, what: str, args: list[str]) -> None:
    """Reads the records the bridge exported from a local site (.cache/bridge/<state>/events)."""
    from zapcycle.config import ROOT
    from zapcycle.state import load_state

    events = ROOT / ".cache" / "bridge" / args[0] / "events" / "matches"
    recs = [json.loads(p.read_text()) for p in events.rglob("*.json")]
    if what == "plays":
        newest = max(recs, key=lambda r: r["endedAt"])
        ai = sorted({s["aiVersion"] for s in newest["seats"] if s["kind"] == "ai"})
        if newest["aiVersion"] != args[1] or newest["arm"] is not None or ai != [args[1]]:
            fail("the newest match did not play only the expected version", aiVersion=newest["aiVersion"], arm=newest["arm"], seats=ai)
        print(json.dumps({"ok": True, "matchEndedAt": newest["endedAt"], "aiVersion": newest["aiVersion"]}))
        return
    new, old = args[1], args[2]
    since = load_state(cfg.data_dir)["promotions"][-1]["at"]
    after = [r for r in recs if r["endedAt"] > since]
    problems = []
    arms = {"candidate": 0, "control": 0, None: 0}
    for r in after:
        arms[r["arm"]] = arms.get(r["arm"], 0) + 1
        want_opp = old if r["arm"] == "control" else new
        if r["test"] is not True or r["aiVersion"] != want_opp or r["partnerVersion"] != old:
            problems.append(r["matchId"])
            continue
        humans = {s["seat"] for s in r["seats"] if s["kind"] == "human"}
        for s in r["seats"]:
            if s["kind"] != "ai":
                continue
            partner_human = r["config"]["players"] == 4 and (s["seat"] ^ 2) in humans
            if s["aiVersion"] != (old if partner_human else want_opp):
                problems.append(r["matchId"])
    if not after or problems or not arms["candidate"] or not arms["control"]:
        fail("records after the promotion do not follow the A/B rules", records=len(after), arms={str(k): v for k, v in arms.items()}, problems=problems[:5])
    print(json.dumps({"ok": True, "records": len(after), "arms": {str(k): v for k, v in arms.items()}}))


if __name__ == "__main__":
    main()
