from __future__ import annotations

import json
from dataclasses import dataclass, fields, is_dataclass
from pathlib import Path
from collections.abc import Mapping
from typing import Any

from game_loop.utils import utc_now


def _json_safe(value: Any, *, depth: int = 0, seen: set[int] | None = None) -> Any:
    """Convert runtime payloads without recursively expanding cycles forever."""

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if depth >= 12:
        return "<max-depth>"
    seen = seen if seen is not None else set()
    marker = id(value)
    if marker in seen:
        return "<cycle>"
    seen.add(marker)
    try:
        if is_dataclass(value) and not isinstance(value, type):
            return {
                field.name: _json_safe(getattr(value, field.name), depth=depth + 1, seen=seen)
                for field in fields(value)
            }
        if isinstance(value, Mapping):
            return {
                str(key): _json_safe(item, depth=depth + 1, seen=seen)
                for key, item in value.items()
            }
        if isinstance(value, (list, tuple, set, frozenset)):
            return [_json_safe(item, depth=depth + 1, seen=seen) for item in list(value)[:2000]]
        if isinstance(value, Path):
            return str(value)
        return repr(value)
    finally:
        seen.remove(marker)


@dataclass(frozen=True)
class TrajectoryEvent:
    sequence: int
    event_type: str
    source: str
    payload: dict[str, Any]
    created_at: str
    schema_version: str = "game-agent.trajectory-event.v1"

    def to_dict(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "event_type": self.event_type,
            "source": self.source,
            "payload": _json_safe(self.payload),
            "created_at": self.created_at,
            "schema_version": self.schema_version,
        }


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
