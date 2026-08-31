from __future__ import annotations

"""Small persistent evidence model for evolved child prototypes.

The model deliberately records observed behavior, rather than deciding fork policy.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from game_loop.utils import atomic_write_json, read_json, utc_now


@dataclass
class PrototypeEvidence:
    prototype_id: str
    uses: int = 0
    completed: int = 0
    settled: int = 0
    adopted: int = 0
    quality_delta_total: float = 0.0
    cost_total: float = 0.0
    boundary_scores: dict[str, float] = field(default_factory=dict)
    boundary_counts: dict[str, int] = field(default_factory=dict)
    lessons: list[str] = field(default_factory=list)

    def observe(
        self,
        *,
        completed: bool,
        settled: bool,
        adopted: bool,
        quality_delta: float | None = None,
        cost: float | None = None,
        boundary: str | None = None,
        lesson: str | None = None,
    ) -> None:
        self.uses += 1
        self.completed += int(completed)
        self.settled += int(settled)
        self.adopted += int(adopted)
        if quality_delta is not None:
            self.quality_delta_total += float(quality_delta)
        if cost is not None:
            self.cost_total += float(cost)
        if boundary and quality_delta is not None:
            count = self.boundary_counts.get(boundary, 0) + 1
            previous = self.boundary_scores.get(boundary, 0.0)
            self.boundary_scores[boundary] = (
                previous * (count - 1) + float(quality_delta)
            ) / count
            self.boundary_counts[boundary] = count
        if lesson and lesson not in self.lessons:
            self.lessons.append(lesson)
            del self.lessons[:-8]

    def boundary_observations(self, boundary: str) -> int:
        return self.boundary_counts.get(boundary, 0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "prototype_id": self.prototype_id,
            "uses": self.uses,
            "completed": self.completed,
            "settled": self.settled,
            "adopted": self.adopted,
            "adoption_rate": self.adopted / self.uses if self.uses else 0.0,
            "quality_delta_total": self.quality_delta_total,
            "cost_total": self.cost_total,
            "boundary_scores": dict(sorted(self.boundary_scores.items())),
            "boundary_counts": dict(sorted(self.boundary_counts.items())),
            "lessons": list(self.lessons),
        }


class PrototypeEvidenceStore:
    schema_version = "subagent-prototype-evidence.v1"

    def __init__(self, path: Path):
        self.path = path
        self.items: dict[str, PrototypeEvidence] = {}

    def load(self) -> "PrototypeEvidenceStore":
        if not self.path.is_file():
            return self
        raw = read_json(self.path)
        for prototype_id, value in dict(raw.get("items", {})).items():
            self.items[str(prototype_id)] = PrototypeEvidence(
                prototype_id=str(prototype_id),
                uses=int(value.get("uses", 0)),
                completed=int(value.get("completed", 0)),
                settled=int(value.get("settled", 0)),
                adopted=int(value.get("adopted", 0)),
                quality_delta_total=float(value.get("quality_delta_total", 0.0)),
                cost_total=float(value.get("cost_total", 0.0)),
                boundary_scores={
                    str(k): float(v)
                    for k, v in dict(value.get("boundary_scores", {})).items()
                },
                boundary_counts=(
                    {
                        str(k): int(v)
                        for k, v in dict(value.get("boundary_counts", {})).items()
                    }
                    or {
                        str(k): 1
                        for k in dict(value.get("boundary_scores", {}))
                    }
                ),
                lessons=[str(item) for item in value.get("lessons", [])],
            )
        return self

    def observe_pair(
        self,
        *,
        prototype_ids: Iterable[str],
        fork_calls: int,
        fork_results: int,
        adopted: int,
        quality_delta: float | None,
        cost: float | None = None,
        boundary: str | None = None,
        lesson: str | None = None,
    ) -> None:
        ids = tuple(dict.fromkeys(str(item) for item in prototype_ids))
        if not ids or fork_calls <= 0:
            return
        for prototype_id in ids:
            item = self.items.setdefault(prototype_id, PrototypeEvidence(prototype_id))
            item.observe(
                completed=fork_results > 0,
                settled=fork_results > 0,
                adopted=adopted > 0,
                quality_delta=quality_delta,
                cost=cost,
                boundary=boundary,
                lesson=lesson,
            )

    def save(self) -> None:
        atomic_write_json(self.path, {
            "schema_version": self.schema_version,
            "updated_at": utc_now(),
            "items": {key: value.to_dict() for key, value in sorted(self.items.items())},
        })

    def summary(self) -> list[dict[str, Any]]:
        return [item.to_dict() for item in sorted(self.items.values(), key=lambda x: x.prototype_id)]
