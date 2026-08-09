from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TYPE_CHECKING

from game_loop.utils import atomic_write_json, read_json, utc_now

if TYPE_CHECKING:
    from game_loop.core.harness import HarnessEpochResult, HarnessModuleConfig, HarnessProfile


@dataclass
class ComponentStat:
    component_id: str
    component_kind: str
    category: str
    usage_count: int = 0
    success_count: int = 0

    @property
    def accuracy(self) -> float:
        if self.usage_count <= 0:
            return 0.0
        return self.success_count / self.usage_count

    def to_dict(self) -> dict[str, Any]:
        return {
            "component_id": self.component_id,
            "component_kind": self.component_kind,
            "category": self.category,
            "usage_count": self.usage_count,
            "success_count": self.success_count,
            "accuracy": self.accuracy,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ComponentStat":
        return cls(
            component_id=str(value["component_id"]),
            component_kind=str(value.get("component_kind", "module")),
            category=str(value.get("category", "workflow")),
            usage_count=int(value.get("usage_count", 0)),
            success_count=int(value.get("success_count", 0)),
        )


@dataclass
class HarnessComponentStatsStore:
    """Tracks per-element usage and accuracy to drive add/remove/modify decisions."""

    root: str
    items: dict[str, ComponentStat] = field(default_factory=dict)
    updated_at: str = field(default_factory=utc_now)

    @classmethod
    def load(cls, path) -> "HarnessComponentStatsStore":
        from pathlib import Path

        file_path = Path(path)
        if not file_path.is_file():
            return cls(root=str(file_path.parent))
        raw = read_json(file_path)
        items = {
            key: ComponentStat.from_dict(value)
            for key, value in dict(raw.get("items", {})).items()
        }
        return cls(
            root=str(file_path.parent),
            items=items,
            updated_at=str(raw.get("updated_at", utc_now())),
        )

    def save(self, path) -> None:
        from pathlib import Path

        file_path = Path(path)
        self.updated_at = utc_now()
        atomic_write_json(
            file_path,
            {
                "schema_version": "harness-component-stats.v1",
                "updated_at": self.updated_at,
                "items": {key: item.to_dict() for key, item in self.items.items()},
            },
        )

    def touch(
        self,
        component_id: str,
        *,
        component_kind: str,
        category: str,
        success: bool,
    ) -> None:
        key = f"{component_kind}:{component_id}"
        stat = self.items.get(key)
        if stat is None:
            stat = ComponentStat(
                component_id=component_id,
                component_kind=component_kind,
                category=category,
            )
            self.items[key] = stat
        stat.usage_count += 1
        if success:
            stat.success_count += 1

    def record_epoch(
        self,
        *,
        profile: "HarnessProfile",
        result: "HarnessEpochResult",
        module_categories: dict[str, str],
    ) -> None:
        success = result.accepted
        for module_id in profile.active_modules:
            self.touch(
                module_id,
                component_kind="module",
                category=module_categories.get(module_id, "workflow"),
                success=success,
            )
        for interface in profile.active_tool_interfaces:
            category = "mcp" if interface.kind == "mcp_server" else "tool"
            self.touch(
                interface.interface_id,
                component_kind="tool_interface",
                category=category,
                success=success,
            )

    def removal_candidates(
        self,
        active_module_ids: set[str],
        *,
        min_usage: int = 3,
        max_accuracy: float = 0.4,
    ) -> list[str]:
        ranked: list[tuple[float, str]] = []
        for module_id in active_module_ids:
            stat = self.items.get(f"module:{module_id}")
            if stat is None:
                continue
            if stat.usage_count >= min_usage and stat.accuracy <= max_accuracy:
                ranked.append((stat.accuracy, module_id))
        ranked.sort()
        return [module_id for _, module_id in ranked]

    def modify_candidates(
        self,
        active_module_ids: set[str],
        *,
        min_usage: int = 2,
        max_accuracy: float = 0.6,
    ) -> list[str]:
        ranked: list[tuple[float, str]] = []
        for module_id in active_module_ids:
            stat = self.items.get(f"module:{module_id}")
            if stat is None:
                continue
            if stat.usage_count >= min_usage and stat.accuracy < max_accuracy:
                ranked.append((stat.accuracy, module_id))
        ranked.sort()
        return [module_id for _, module_id in ranked]

    def addition_candidates(
        self,
        catalog: dict[str, "HarnessModuleConfig"],
        active_module_ids: set[str],
        *,
        min_peer_accuracy: float = 0.55,
    ) -> list[str]:
        active_acc = [
            self.items[f"module:{module_id}"].accuracy
            for module_id in active_module_ids
            if f"module:{module_id}" in self.items and self.items[f"module:{module_id}"].usage_count > 0
        ]
        baseline = sum(active_acc) / len(active_acc) if active_acc else min_peer_accuracy
        additions: list[tuple[float, str]] = []
        for module_id, module in catalog.items():
            if module_id in active_module_ids:
                continue
            stat = self.items.get(f"module:{module_id}")
            score = stat.accuracy if stat and stat.usage_count > 0 else baseline
            additions.append((score, module_id))
        additions.sort(reverse=True)
        return [module_id for _, module_id in additions]
