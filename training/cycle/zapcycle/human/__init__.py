"""Human layers (contract 3.11). Each layer stays off until its threshold and is checked again every
cycle. run_human_layers(ctx) runs once per cycle after build; command(name, ctx, args) runs the
commands human-model, priors, flags, player-types and open-data.

Order in a cycle: flags first (a group flagged now leaves every other layer of this cycle at once),
then the profiles and the population priors, the player types, the human behaviour model and the
open data package. A layer that fails is logged and reported off with the error; the cycle goes
on, because training does not depend on any of them.
"""

from __future__ import annotations

import json
import traceback
from typing import Any

from ..context import CycleContext, HumanResult
from ..errors import CycleError, GuardError
from .common import dump, latest_export, layer, tables_summary, work

LAYERS = ("humanModel", "priors", "adaptation", "playerTypes", "ranking", "openData", "flags")
# The public reason of a layer that failed in this cycle (the exception goes to the log and the report).
FAILED_WHY = "Failed in this cycle; see the cycle log."
WHY = {
    "humanModel": "switched off until the thresholds are reached",
    "priors": "switched off until the thresholds are reached",
    "adaptation": "Waits for features with profile inputs; each person's profile becomes a network input only after that.",
    "playerTypes": "switched off until the thresholds are reached",
    "ranking": "The rating comes in a later milestone.",
    "openData": "switched off until the thresholds are reached",
    "flags": "switched off until the thresholds are reached",
}


def _valid_matches(ctx: CycleContext) -> int | None:
    p = ctx.tables_dir / "summary.json"
    if not p.exists():
        return None
    return int(json.loads(p.read_text()).get("validMatches", 0))


def layers_off(valid_matches: int | None) -> dict[str, dict]:
    """Every layer off (summary.json before the first cycle with tables)."""
    progress = {"matches": valid_matches} if valid_matches is not None else {}
    return {k: {"on": False, "why": WHY[k], "progress": dict(progress)} for k in LAYERS}


def _fixed_layers(ctx: CycleContext, vm: int) -> dict[str, dict]:
    t = ctx.config.thresholds
    return {
        "adaptation": layer(False, WHY["adaptation"], matches=vm, decisionsNeeded=int(t["adapt_decisions"])),
        "ranking": layer(False, WHY["ranking"], matches=vm, peopleNeeded=int(t["ranking_people"]), matchesEach=int(t["ranking_matches_each"])),
    }


def _guarded(ctx: CycleContext, name: str, errors: dict, fn, fallback):
    try:
        return fn()
    except Exception as e:  # one layer's failure never stops training
        ctx.log.error(f"human layer {name} failed: {type(e).__name__}: {e}")
        ctx.log.debug(traceback.format_exc())
        errors[name] = f"{type(e).__name__}: {e}"[:300]
        return fallback


def run_human_layers(ctx: CycleContext, env: dict | None = None) -> HumanResult:
    from . import flags, model, opendata, player_types, priors

    summary = tables_summary(ctx)
    vm = int(summary.get("validMatches") or 0)
    layers: dict[str, dict] = layers_off(vm if summary else None)
    layers.update(_fixed_layers(ctx, vm))
    errors: dict[str, str] = {}
    report: dict[str, Any] = {"cycleId": ctx.cycle_id, "export": (latest_export(ctx) or {}).get("date")}

    def failed(name: str, **progress) -> dict:
        # summary.json is public (GET /api/summary): a fixed sentence there, never the exception's
        # text, which may carry a path or a group token. The exception stays in the log and the report.
        return layer(False, FAILED_WHY, **progress)

    # Flags first: whoever is flagged now is left out of every other layer of this cycle.
    fl = _guarded(ctx, "flags", errors, lambda: flags.run_flags(ctx), None)
    exclude: set[str] = set()
    if fl is None:
        layers["flags"] = failed("flags", people=None)
    else:
        layers["flags"], exclude, report["flags"] = fl

    prof = _guarded(ctx, "priors", errors, lambda: priors.run_profiles(ctx, exclude), None) if summary else None
    readings: list[dict] = []
    if prof is not None:
        pr = _guarded(ctx, "priors", errors, lambda: priors.run_priors(ctx, prof), None)
        if pr is None:
            layers["priors"] = failed("priors", people=None)
        else:
            layers["priors"], report["priors"] = pr
            readings = priors.readings(ctx)
    elif summary:
        layers["priors"] = failed("priors", people=None)

    block = None
    if summary:
        pt = _guarded(ctx, "playerTypes", errors, lambda: player_types.run_player_types(ctx, readings), None)
        if pt is None:
            layers["playerTypes"] = failed("playerTypes", people=None)
        else:
            layers["playerTypes"], block, report["playerTypes"] = pt

    human_model = None
    card = None
    if summary:
        hm = _guarded(ctx, "humanModel", errors, lambda: model.run_human_model(ctx, exclude, summary), None)
        if hm is None:
            layers["humanModel"] = failed("humanModel", matches=vm)
        else:
            layers["humanModel"], human_model, card, report["humanModel"] = hm

    if summary:
        od = _guarded(ctx, "openData", errors, lambda: opendata.run_open_data(ctx, exclude, readings, summary, env), None)
        if od is None:
            layers["openData"] = failed("openData", matches=vm)
        else:
            layers["openData"], report["openData"] = od

    report["errors"] = errors
    report["layers"] = layers
    dump(work(ctx) / "report.json", report)
    return HumanResult(layers=layers, human_model=human_model, human_model_report=card, summary={"playerTypes": block})


def command(name: str, ctx: CycleContext, args: Any, env: dict | None = None) -> dict:
    """The owner's commands. They work on the newest cycle's tables (run `build` first for new data)."""
    return {"command": name, **_command(name, ctx, args, env)}


def _command(name: str, ctx: CycleContext, args: Any, env: dict | None) -> dict:
    from . import flags, model, player_types, priors

    if name == "flags":
        action = getattr(args, "action", "list")
        if action == "list":
            return flags.cmd_list(ctx)
        if action == "push":
            return flags.cmd_push(ctx)
        return flags.cmd_review(ctx, action, getattr(args, "ref", None))
    summary = tables_summary(ctx)
    if not summary:
        raise CycleError("no decision tables yet: run build first")
    exclude = flags.flagged_groups(ctx, (latest_export(ctx) or {}).get("date"))
    if name == "priors":
        prof = priors.run_profiles(ctx, exclude)
        lay, rep = priors.run_priors(ctx, prof)
        return {"layer": lay, **rep}
    if name == "player-types":
        lay, block, rep = player_types.run_player_types(ctx, priors.readings(ctx) or _readings_now(ctx, exclude))
        return {"layer": lay, "playerTypes": block, "report": rep}
    if name == "human-model":
        lay, path, card, rep = model.run_human_model(ctx, exclude, summary)
        return {"layer": lay, "model": str(path) if path else None, "card": card, "report": rep}
    if name == "open-data":
        return _open_data(ctx, args, summary, env, exclude)
    raise CycleError(f"unknown human layer command {name}")


def _readings_now(ctx: CycleContext, exclude: set[str]) -> list[dict]:
    from . import priors

    priors.run_profiles(ctx, exclude)
    return priors.readings(ctx)


def _open_data(ctx: CycleContext, args: Any, summary: dict, env: dict | None, exclude: set[str]) -> dict:
    """open-data builds the package of the newest cycle again (new codes); open-data --upload sends the
    package that is already there, the one the owner could look at, and never builds one. It refuses
    a package built from an export older than the newest one (opendata.check_fresh)."""
    import os

    from . import opendata, priors

    env = os.environ if env is None else env
    if not getattr(args, "upload", False):
        lay, pkg = opendata.run_open_data(ctx, exclude, priors.readings(ctx) or _readings_now(ctx, exclude), summary, env)
        out: dict[str, Any] = {"layer": lay}
        if lay["on"]:
            out["package"] = {"zip": pkg["zip"], "sha256": pkg["sha256"], "matches": pkg["manifest"]["matches"], "decisions": pkg["manifest"]["decisions"], "cells": pkg["manifest"]["cells"]}
        return out
    state = opendata.gate(ctx, summary, env)
    if not state["on"]:
        return {"layer": state}
    # The command line synced just before (cli.dispatch), so state.latestExport is the newest export.
    return {"layer": state, **upload_package(ctx, env, auto=False)}


MAX_RELEASES_KEPT = 50  # open data uploads remembered in state.json


def dry_run(ctx: CycleContext, m: dict) -> bool:
    """Local profiles and test packages never reach GitHub."""
    return ctx.config.mode != "r2" or bool(m["test"])


def first_release_done(ctx: CycleContext, dry: bool) -> bool:
    """Whether the owner already uploaded a release by hand (open-data --upload) in this mode: the
    cycle uploads on its own only after that first one, which the owner looked inside."""
    return any(r.get("dryRun") is dry and not r.get("auto") for r in ctx.state.get("openDataReleases") or [])


def upload_package(ctx: CycleContext, env, auto: bool) -> dict:
    """Uploads the newest cycle's package (never builds one), after opendata.check_fresh, and records
    the upload in state.json. The caller synced first. auto: the cycle's own upload after a
    promotion (cli.open_data_after_promotion)."""
    from . import github, opendata

    found = opendata.latest_package(ctx)
    if found is None:
        raise CycleError("no package in the newest cycle: run open-data, look inside the zip, then open-data --upload")
    zip_path, m = found
    if m["matches"] == 0:
        raise GuardError("the package holds no match: nothing to upload")
    opendata.check_fresh(m, ctx.state.get("latestExport"), ctx.now_ms)
    dry = dry_run(ctx, m)
    send = github.DryRun() if dry else github.http_sender
    repo = opendata.settings(ctx)["repo"]
    token = env.get("GITHUB_RELEASES_TOKEN", "") or ("dry-run" if dry else "")
    notes = (
        f"Zap open data, cycle {ctx.cycle_id}: {m['matches']} matches and {m['decisions']} decisions in cells of at least "
        f"{m['minPeoplePerCell']} people. License CC BY 4.0. Columns in DICTIONARY.md inside the zip."
    )
    res = github.publish_release(repo or ("OWNER/REPO" if dry else ""), m["release"], f"Zap open data {m['created']}", notes, zip_path, token, send)
    sha = opendata.sha256_file(zip_path)
    entry = {"release": m["release"], "sha256": sha, "exportDate": m["exportDate"], "matches": m["matches"], "at": ctx.now_ms, "dryRun": dry, "auto": auto}
    ctx.state["openDataReleases"] = (list(ctx.state.get("openDataReleases") or []) + [entry])[-MAX_RELEASES_KEPT:]
    ctx.state.save()
    out = {"package": {"zip": str(zip_path), "sha256": sha}, "upload": {**res, "dryRun": dry}}
    if dry:
        out["upload"]["requests"] = send.requests
    return out
