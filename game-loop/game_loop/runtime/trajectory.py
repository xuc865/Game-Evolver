from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from game_loop.utils import utc_now


@dataclass(frozen=True)
class TrajectoryEvent:
    sequence: int
    event_type: str
    source: str
    payload: dict[str, Any]
    created_at: str
    schema_version: str = "game-agent.trajectory-event.v1"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class TrajectoryRecorder:
    def __init__(self, path: Path):
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("", encoding="utf-8")
        self.sequence = 0

    def record(self, event_type: str, source: str, payload: dict[str, Any]) -> TrajectoryEvent:
        self.sequence += 1
        event = TrajectoryEvent(self.sequence, event_type, source, payload, utc_now())
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event.to_dict(), ensure_ascii=False) + "\n")
        return event
