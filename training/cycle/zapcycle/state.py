"""Local state of a profile: data/<profile>/state.json (P1 writes, P2 reads).

{cursorDate, lastCycleId, lastCycleStartedAt, lastAbCheckDate, promotions: [{version, at, parent}],
 ab: {version, control, from, until} or null, seedFloor: {cycleId, pairs, mean, lo, hi} or null,
 seedFloors: every seed floor measured, oldest first (at most 50), cyclesSinceSeedFloor,
 latestExport: {date, sha256, key} or null, lastVersionNumber,
 openDataReleases: the open data uploads, oldest first (at most 50): {release, sha256, exportDate,
 matches, at, dryRun, auto},
 explorerFailures: the explorers on record as failing against an earlier file (zapcycle/explorer.py),
 explorerMeasured: every explorer measured against a file, with each file (zapcycle/explorer.py),
 explorerVerdicts: the explorer step of every reading candidate, oldest first (at most 200)}
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT = {
    "cursorDate": None,
    "lastCycleId": None,
    "lastCycleStartedAt": None,
    "lastAbCheckDate": None,
    "promotions": [],
    "ab": None,
    "seedFloor": None,
    "seedFloors": [],
    "cyclesSinceSeedFloor": 0,
    "latestExport": None,
    "lastVersionNumber": 1,
    "openDataReleases": [],
    "explorerFailures": [],
    "explorerMeasured": [],
    "explorerVerdicts": [],
}


def write_json_atomic(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


class State(dict):
    def __init__(self, path: Path):
        self.path = Path(path)
        data = dict(DEFAULT)
        if self.path.exists():
            data.update(json.loads(self.path.read_text()))
        super().__init__(data)

    def save(self) -> None:
        write_json_atomic(self.path, dict(self))


def load_state(data_dir: Path) -> State:
    return State(Path(data_dir) / "state.json")


def version_number(v: str) -> int:
    return int(v[1:])
