from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from game_loop.config import HarnessRubricCriterion
from game_loop.core.harness import HarnessProfile
from game_loop.utils import atomic_write_json, read_json, utc_now


# Abstract benchmark families — references intent only, never official rubrics/tests.
_BENCH_FAMILY_HINTS: dict[str, str] = {
    "gcbench": "Godot game crafting with deterministic input replay evidence",
    "gdbench": "godot engine game development with import/runtime checks",
    "vgamegym": "multi-file game code iteration with visual/runtime validation",
    "verigame": "web game build with npm/playwright-style verification",
}

_FORBIDDEN_RUBRIC_TERMS = frozenset({
    "hidden test",
    "hidden rubric",
    "official score",
    "primary_score",
    "benchmark reward",
    "oracle shortcut",
    "rubric.json",
    "tests/rubric",
})

_RUBRIC_POLICY_VERSION = "frozen-parent-game-quality-v2"


@dataclass(frozen=True)
class DynamicRubricSet:
    """Task- and harness-scoped internal rubrics (never identical to official metrics)."""

    rubric_id: str
    task_ref: str
    benchmark_id: str
    harness_loop_role: str
    harness_focus: tuple[str, ...]
    hard_rubrics: tuple[HarnessRubricCriterion, ...]
    soft_rubrics: tuple[HarnessRubricCriterion, ...]
    generation_notes: str
    official_metric_isolation: str
    created_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rubric_id": self.rubric_id,
            "task_ref": self.task_ref,
            "benchmark_id": self.benchmark_id,
            "harness_loop_role": self.harness_loop_role,
            "harness_focus": list(self.harness_focus),
            "hard_rubrics": [item.to_dict() for item in self.hard_rubrics],
            "soft_rubrics": [item.to_dict() for item in self.soft_rubrics],
            "generation_notes": self.generation_notes,
            "official_metric_isolation": self.official_metric_isolation,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "DynamicRubricSet":
        return cls(
            rubric_id=str(value["rubric_id"]),
            task_ref=str(value["task_ref"]),
            benchmark_id=str(value.get("benchmark_id", "unknown")),
            harness_loop_role=str(value.get("harness_loop_role", "inner")),
            harness_focus=tuple(str(item) for item in value.get("harness_focus", [])),
            hard_rubrics=tuple(
                HarnessRubricCriterion.from_dict(dict(item))
                for item in value.get("hard_rubrics", [])
            ),
            soft_rubrics=tuple(
                HarnessRubricCriterion.from_dict(dict(item))
                for item in value.get("soft_rubrics", [])
            ),
            generation_notes=str(value.get("generation_notes", "")),
            official_metric_isolation=str(value.get("official_metric_isolation", "")),
            created_at=str(value.get("created_at", utc_now())),
        )


def _instruction_excerpt(task_source: Path) -> str:
    for name in (
        "instruction.md",
        "instruction.txt",
        "specification.md",
        "requirement.md",
        "README.md",
    ):
        path = task_source / name
        if path.is_file():
            return path.read_text(encoding="utf-8", errors="replace")[:6000]
    return ""


def _task_mechanics_hint(text: str) -> str:
    lowered = text.lower()
    hints: list[str] = []
    for keyword, label in (
        ("control", "player controls"),
        ("score", "scoring loop"),
        ("level", "level progression"),
        ("enemy", "enemy interaction"),
        ("collision", "collision handling"),
        ("ui", "ui feedback"),
        ("multiplayer", "multiplayer logic"),
    ):
        if keyword in lowered:
            hints.append(label)
    return ", ".join(hints[:4]) if hints else "core gameplay loop from public instruction"


def _harness_focus_tags(
    profile: HarnessProfile,
    module_categories: dict[str, str] | None = None,
) -> tuple[str, ...]:
    del module_categories
    if profile.active_elements:
        return tuple(sorted({element.category for element in profile.active_elements}))
    tags: list[str] = []
    for module_id in profile.active_modules:
        tags.append("workflow")
    for interface in profile.active_tool_interfaces:
        tags.append("mcp" if interface.kind == "mcp_server" else "tool")
    return tuple(sorted(dict.fromkeys(tags)))


def _validate_no_leakage(criterion: HarnessRubricCriterion) -> None:
    text = f"{criterion.rubric_id} {criterion.description}".lower()
    for term in _FORBIDDEN_RUBRIC_TERMS:
        if term in text:
            raise ValueError(f"dynamic rubric leaks official metric term: {term}")


def _build_hard_rubrics(
    *,
    task_source: Path,
    benchmark_id: str,
    harness_focus: Sequence[str],
) -> tuple[HarnessRubricCriterion, ...]:
    mechanics = _task_mechanics_hint(_instruction_excerpt(task_source))
    family = _BENCH_FAMILY_HINTS.get(benchmark_id, "general game-making task")
    items = [
        HarnessRubricCriterion(
            "deep_runtime_legal",
            "hard",
            (
                "After deep in-game execution, the candidate runs without fatal crash "
                f"while respecting public task constraints ({mechanics})."
            ),
        ),
        HarnessRubricCriterion(
            "public_spec_integrity",
            "hard",
            (
                "The delivered artifact has the public task's required runnable structure "
                "and contains no benchmark-private rubric or test files."
            ),
        ),
        HarnessRubricCriterion(
            "harness_safe_workspace",
            "hard",
            "The collected artifact is rooted in the isolated episode workspace and all inventoried paths are relative to it.",
        ),
    ]
    if "skill" in harness_focus:
        items.append(
            HarnessRubricCriterion(
                "skill_application_valid",
                "hard",
                "The artifact remains build- and runtime-legal after the active skill workflow is applied.",
            )
        )
    if "mcp" in harness_focus:
        items.append(
            HarnessRubricCriterion(
                "mcp_boundary_respected",
                "hard",
                "The collected artifact remains inside the isolated episode workspace after MCP-assisted work.",
            )
        )
    del family  # referenced in soft rubrics only as abstract hint
    for item in items:
        _validate_no_leakage(item)
    return tuple(items)


def _build_soft_rubrics(
    *,
    task_source: Path,
    benchmark_id: str,
    harness_focus: Sequence[str],
    loop_role: str,
) -> tuple[HarnessRubricCriterion, ...]:
    family = _BENCH_FAMILY_HINTS.get(benchmark_id, "game-making")
    instruction = _instruction_excerpt(task_source)
    mechanics = _task_mechanics_hint(instruction)
    base = [
        HarnessRubricCriterion(
            "public_feature_completion",
            "soft",
            (
                "Observable gameplay implements the important requirements in the public task "
                f"instruction, including {mechanics}; nominal files, labels, or planned features "
                "without executable behavior receive no credit."
            ),
            weight=0.25,
        ),
        HarnessRubricCriterion(
            "core_gameplay_depth",
            "soft",
            (
                "The core game loop has meaningful state transitions, consequences, and enough "
                f"mechanical depth to sustain play in this {family} task."
            ),
            weight=0.20,
        ),
        HarnessRubricCriterion(
            "interaction_correctness",
            "soft",
            (
                "Real player inputs trigger correct, deterministic gameplay responses, and the "
                "runtime evidence shows those responses rather than only a launch or title screen."
            ),
            weight=0.15,
        ),
        HarnessRubricCriterion(
            "progression_and_end_state",
            "soft",
            (
                "The game supports coherent progression and reaches task-appropriate success, "
                "failure, result, or completion states through actual play."
            ),
            weight=0.15,
        ),
        HarnessRubricCriterion(
            "playability_and_balance",
            "soft",
            (
                "The game is practically playable: controls, pacing, challenge, resources, and "
                "failure recovery do not block or trivialize the intended experience."
            ),
            weight=0.10,
        ),
        HarnessRubricCriterion(
            "runtime_feedback_quality",
            "soft",
            (
                "Runtime presentation clearly communicates actions, state changes, hazards, "
                "progress, and outcomes through readable visual or textual feedback."
            ),
            weight=0.10,
        ),
        HarnessRubricCriterion(
            "demo_coverage",
            "soft",
            (
                "Completed deterministic replay evidence covers the core loop and important "
                "states; demo JSON or nominal scenarios without successful replay receive no credit."
            ),
            weight=0.05,
        ),
    ]
    del harness_focus, loop_role
    for item in base:
        _validate_no_leakage(item)
    return tuple(base)


def generate_dynamic_rubric_set(
    *,
    task_ref: Path,
    benchmark_id: str,
    harness_profile: HarnessProfile,
    loop_role: str,
    module_categories: dict[str, str] | None = None,
) -> DynamicRubricSet:
    """Generate internal rubrics from task + harness type; never copy official metrics."""
    categories = module_categories or {}
    focus = _harness_focus_tags(harness_profile, categories)
    hard = _build_hard_rubrics(
        task_source=task_ref,
        benchmark_id=benchmark_id,
        harness_focus=focus,
    )
    soft = _build_soft_rubrics(
        task_source=task_ref,
        benchmark_id=benchmark_id,
        harness_focus=focus,
        loop_role=loop_role,
    )
    payload = {
        "rubric_policy_version": _RUBRIC_POLICY_VERSION,
        "task_ref": str(task_ref.resolve()),
        "benchmark_id": benchmark_id,
        "loop_role": loop_role,
        "focus": list(focus),
        "modules": list(harness_profile.active_modules),
        "tools": [item.interface_id for item in harness_profile.active_tool_interfaces],
    }
    rubric_id = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]
    isolation = (
        "Internal harness rubrics evaluate process legality and play experience from deep runs. "
        "They intentionally differ from frozen official benchmark metrics to prevent data leakage."
    )
    return DynamicRubricSet(
        rubric_id=rubric_id,
        task_ref=str(task_ref.resolve()),
        benchmark_id=benchmark_id,
        harness_loop_role=loop_role,
        harness_focus=focus,
        hard_rubrics=hard,
        soft_rubrics=soft,
        generation_notes=(
            f"Policy {_RUBRIC_POLICY_VERSION}; generated before mutation from the parent "
            f"{loop_role} harness for task {task_ref.name}."
        ),
        official_metric_isolation=isolation,
    )


class DynamicRubricArchive:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.path = self.root / "dynamic_rubrics.json"

    def save(self, case_id: str, rubric: DynamicRubricSet) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        value = read_json(self.path) if self.path.is_file() else {"items": {}}
        items = dict(value.get("items", {}))
        items[case_id] = rubric.to_dict()
        atomic_write_json(self.path, {"schema_version": "dynamic-rubric.v1", "items": items})

    def get(self, case_id: str) -> DynamicRubricSet | None:
        if not self.path.is_file():
            return None
        items = read_json(self.path).get("items", {})
        raw = items.get(case_id)
        return None if raw is None else DynamicRubricSet.from_dict(raw)
