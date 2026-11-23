"""What a cycle step receives (contract 3.11): CycleContext, and HumanResult from the human layers."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Config
from .state import State


@dataclass
class CycleContext:
    config: Config
    profile: str
    cycle_id: str
    now_ms: int
    data_dir: Path
    work_dir: Path
    tables_dir: Path
    events: Any  # storage.Bucket (events, read only) or None
    models: Any  # storage.Bucket (models, publish role) or None
    public: Any  # storage.Bucket (public, publish role) or None
    log: logging.Logger
    state: State


@dataclass
class HumanResult:
    layers: dict[str, dict]  # keys of summary.layers: {"on": bool, "why": str, "progress": dict}
    human_model: Path | None  # passed its test; joins the league
    human_model_report: dict | None  # for card.training.humanModel and cycle.md
    summary: dict = field(default_factory=dict)  # {"playerTypes": ... or None}
