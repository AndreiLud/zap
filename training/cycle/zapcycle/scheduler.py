"""The scheduler (contract 3.12): one tick every tick_seconds.

At each tick: nothing while the cycle lock is held. Once a day after ab_check_utc: the A/B check,
which also refreshes status.updatedAt. When an A/B window has ended but is still in state.json, the
closing check runs at once (it closes the window or rolls back), before anything else may start.
Then a cycle starts when no A/B window is open or waiting to close, and either the
latest weekly slot (weekday at time in timezone) came after the last cycle's start, or at least
new_matches new records arrived since cursorDate (listing at most once an hour). A missed slot
(machine off) runs once at the next tick. The cycle is a subprocess killed at max_cycle_hours.

Fake clock for tests: --now ISO sets the start, --tick-advance S moves the clock S seconds per tick
without sleeping, --ticks N stops after N ticks, --dry-run prints one JSON line per decision and
starts nothing.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from .config import ROOT, Config
from .core import Cycle
from .index import Index
from .lock import lock_holder
from .proc import kill_group
from .state import load_state, write_json_atomic

HOUR = 3600.0


def latest_slot(now: datetime, weekday: int, hhmm: str, tz: str) -> datetime:
    """The latest weekly slot at or before now, in UTC."""
    z = ZoneInfo(tz)
    local = now.astimezone(z)
    h, m = (int(x) for x in hhmm.split(":"))
    day = local.date() - timedelta(days=(local.weekday() - weekday) % 7)
    slot = datetime(day.year, day.month, day.day, h, m, tzinfo=z)
    if slot > local:
        slot -= timedelta(days=7)
    return slot.astimezone(timezone.utc)


def ab_due(now: datetime, hhmm: str, last_check: str | None) -> bool:
    h, m = (int(x) for x in hhmm.split(":"))
    return now.astimezone(timezone.utc).time() >= datetime(2000, 1, 1, h, m).time() and last_check != now.astimezone(timezone.utc).date().isoformat()


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def count_new_records(cyc: Cycle, now: datetime) -> int:
    """New records since the last cycle: keys under the days from cursorDate - 1 to today that the
    index does not hold, plus the ones synced since the last cycle (the daily A/B check syncs too)."""
    from .sync import day_prefixes

    known = Index(cyc.cfg.data_dir / "index.sqlite")
    try:
        keys = known.keys()
    finally:
        known.close()
    n = max(0, len(keys) - int(cyc.state.get("recordsAtLastCycle") or 0))
    cursor = cyc.state.get("cursorDate")
    if cursor is None:
        return n
    for p in day_prefixes(cursor, now.astimezone(timezone.utc).date().isoformat()):
        n += sum(1 for o in cyc.events.list(p) if o.key.endswith(".json") and o.key not in keys)
    return n


@dataclass
class Memory:
    """What the scheduler remembers between ticks (data/<profile>/scheduler.json)."""

    since: int | None = None
    last_list_at: int | None = None
    new_records: int = 0
    extra: dict = field(default_factory=dict)


class Scheduler:
    def __init__(
        self,
        cfg: Config,
        config_path: str,
        dry_run: bool = False,
        out: Callable[[str], None] = print,
        lister: Callable[[datetime], int] | None = None,
        run_cmd: Callable[[list[str], float], dict] | None = None,
        status_failed: Callable[[str], None] | None = None,
    ):
        self.cfg = cfg
        self.config_path = config_path
        self.dry_run = dry_run
        self.out = out
        self.lister = lister
        self.run_cmd = run_cmd or self._subprocess
        self.status_failed = status_failed
        self.mem_path = cfg.data_dir / "scheduler.json"
        self.mem = Memory()
        if self.mem_path.exists():
            d = json.loads(self.mem_path.read_text())
            self.mem = Memory(d.get("since"), d.get("lastListAt"), d.get("newRecords", 0))
        self.sim: dict = {}  # dry run: state changes kept in memory only

    def _save_mem(self) -> None:
        if not self.dry_run:
            write_json_atomic(self.mem_path, {"since": self.mem.since, "lastListAt": self.mem.last_list_at, "newRecords": self.mem.new_records})

    def _state(self) -> dict:
        s = dict(load_state(self.cfg.data_dir))
        s.update(self.sim)
        return s

    def _emit(self, tick: int, now: datetime, action: str, reason: str, **extra) -> dict:
        d = {"tick": tick, "at": iso(now), "action": action, "reason": reason, **extra}
        self.out(json.dumps(d))
        return d

    def _cycle_cmd(self, command: str) -> list[str]:
        return [sys.executable, str(ROOT / "training" / "cycle" / "cycle.py"), "--config", self.config_path, command]

    def _subprocess(self, cmd: list[str], limit_s: float) -> dict:
        return run_with_deadline(cmd, limit_s, time.time, time.sleep)

    def tick(self, i: int, now: datetime) -> list[dict]:
        sc = self.cfg.schedule
        out: list[dict] = []
        holder = lock_holder(self.cfg.data_dir / "locks" / "cycle.lock")
        if holder is not None:
            return [self._emit(i, now, "wait", "the cycle lock is held", holder=holder)]
        if self.mem.since is None:
            self.mem.since = ms(now)
            self._save_mem()
        st = self._state()
        if ab_due(now, sc["ab_check_utc"], st.get("lastAbCheckDate")):
            out.append(self._emit(i, now, "ab", "daily A/B check and status refresh"))
            if self.dry_run:
                self.sim["lastAbCheckDate"] = now.astimezone(timezone.utc).date().isoformat()
            else:
                self.run_cmd(self._cycle_cmd("ab"), 2 * HOUR)
            st = self._state()
        ab = st.get("ab")
        if ab and ms(now) >= ab["until"]:
            # The window ended but is not closed yet: the final check (and a possible rollback)
            # comes before any new cycle, which would otherwise hold the lock and could promote
            # a version over one whose window never closed.
            out.append(self._emit(i, now, "ab", "the A/B window ended: final check and close"))
            if self.dry_run:
                self.sim["ab"] = None
                self.sim["lastAbCheckDate"] = now.astimezone(timezone.utc).date().isoformat()
            else:
                self.run_cmd(self._cycle_cmd("ab"), 2 * HOUR)
            st = self._state()
            ab = st.get("ab")
        if ab:
            until = iso(datetime.fromtimestamp(ab["until"] / 1000, timezone.utc))
            reason = f"A/B window open until {until}" if ms(now) < ab["until"] else f"A/B window ended at {until} and is not closed yet; the close is tried again at the next tick"
            out.append(self._emit(i, now, "idle", reason))
            return out
        slot = latest_slot(now, int(sc["weekday"]), sc["time"], sc["timezone"])
        last = st.get("lastCycleStartedAt") or self.mem.since
        reason = None
        if ms(slot) > last:
            reason = f"weekly slot {iso(slot)}"
        else:
            if self.mem.last_list_at is None or ms(now) - self.mem.last_list_at >= HOUR * 1000:
                self.mem.last_list_at = ms(now)
                try:
                    self.mem.new_records = self.lister(now) if self.lister else 0
                except Exception as e:  # listing is best effort; the weekly slot still runs
                    out.append(self._emit(i, now, "warn", f"listing new records failed: {type(e).__name__}"))
                    self.mem.new_records = 0
                self._save_mem()
            if self.mem.new_records >= int(sc["new_matches"]):
                reason = f"{self.mem.new_records} new matches"
        if reason is None:
            out.append(self._emit(i, now, "idle", "no slot due and too few new matches", newRecords=self.mem.new_records))
            return out
        out.append(self._emit(i, now, "cycle", reason))
        if self.dry_run:
            self.sim["lastCycleStartedAt"] = ms(now)
            self.mem.new_records = 0
        else:
            res = self.run_cmd(self._cycle_cmd("run"), float(sc["max_cycle_hours"]) * HOUR)
            self.mem.new_records = 0
            self._save_mem()
            if res.get("killed"):
                out.append(self._emit(i, now, "killed", "time limit"))
                if self.status_failed:
                    self.status_failed(f"time limit: the cycle ran {sc['max_cycle_hours']} hours and was stopped")
        return out

    def loop(self, start: datetime | None, ticks: int | None, advance: float | None, sleep: Callable[[float], None] = time.sleep) -> list[dict]:
        decisions: list[dict] = []
        now = start or datetime.now(timezone.utc)
        i = 0
        while ticks is None or i < ticks:
            decisions += self.tick(i, now)
            i += 1
            if ticks is not None and i >= ticks:
                break
            if advance is not None:
                now = now + timedelta(seconds=advance)
            else:
                sleep(float(self.cfg.schedule["tick_seconds"]))
                now = datetime.now(timezone.utc)
        return decisions


def run_with_deadline(cmd: list[str], limit_s: float, clock: Callable[[], float], sleep: Callable[[float], None], popen=None, poll_s: float = 30.0) -> dict:
    """Runs cmd as its own process group; kills the group when it passes limit_s."""
    popen = popen or (lambda c: subprocess.Popen(c, cwd=ROOT, env=dict(os.environ), start_new_session=True))
    p = popen(cmd)
    start = clock()
    while True:
        rc = p.poll()
        if rc is not None:
            return {"returncode": rc, "killed": False, "seconds": clock() - start}
        if clock() - start >= limit_s:
            kill_group(p)
            return {"returncode": p.poll(), "killed": True, "seconds": clock() - start}
        sleep(poll_s)

