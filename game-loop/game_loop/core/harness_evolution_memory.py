from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Sequence

from game_loop.core.harness import HarnessEpochResult, HarnessProfile
from game_loop.utils import utc_now


def _clip_text(value: object, *, limit: int = 240) -> str:
    text = " ".join(str(value).split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


@dataclass(frozen=True)
class HarnessRejectionExperience:
    """Structured, reusable lesson from a rejected harness mutation."""

    epoch: int
    loop_role: str
    parent_harness_id: str
    candidate_harness_id: str
    harness_delta_summary: str
    failed_tasks: tuple[str, ...]
    hard_rubric_misses: tuple[str, ...]
    soft_regression_summary: str
    root_cause: str
    do_not_repeat: tuple[str, ...]
    evidence_refs: tuple[str, ...] = ()
    created_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["failed_tasks"] = list(self.failed_tasks)
        value["hard_rubric_misses"] = list(self.hard_rubric_misses)
        value["do_not_repeat"] = list(self.do_not_repeat)
        value["evidence_refs"] = list(self.evidence_refs)
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessRejectionExperience":
        return cls(
            epoch=int(value["epoch"]),
            loop_role=str(value.get("loop_role", "inner")),
            parent_harness_id=str(value["parent_harness_id"]),
            candidate_harness_id=str(value["candidate_harness_id"]),
            harness_delta_summary=str(value.get("harness_delta_summary", "")),
            failed_tasks=tuple(str(item) for item in value.get("failed_tasks", [])),
            hard_rubric_misses=tuple(
                str(item) for item in value.get("hard_rubric_misses", [])
            ),
            soft_regression_summary=str(value.get("soft_regression_summary", "")),
            root_cause=str(value.get("root_cause", "")),
            do_not_repeat=tuple(str(item) for item in value.get("do_not_repeat", [])),
            evidence_refs=tuple(str(item) for item in value.get("evidence_refs", [])),
            created_at=str(value.get("created_at", utc_now())),
        )


class HarnessEvolutionMemory:
    """Append-only store of rejected harness experiences for proposer context."""

    schema_version = "harness-rejection-memory.v1"

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.path = self.root / "rejection_experience.jsonl"

    def append(self, experience: HarnessRejectionExperience) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(experience.to_dict(), ensure_ascii=False) + "\n")

    def load_recent(self, *, limit: int = 8) -> tuple[HarnessRejectionExperience, ...]:
        if not self.path.is_file():
            return ()
        lines = self.path.read_text(encoding="utf-8").splitlines()
        items = [
            HarnessRejectionExperience.from_dict(json.loads(line))
            for line in lines[-limit:]
            if line.strip()
        ]
        return tuple(items)

    def render_proposer_context(
        self,
        *,
        loop_role: str,
        limit: int = 5,
    ) -> str:
        recent = [
            item
            for item in self.load_recent(limit=limit * 2)
            if item.loop_role == loop_role
        ][-limit:]
        if not recent:
            return ""
        lines = [
            "Prior rejected harness mutations (do not repeat these failure patterns):"
        ]
        for item in recent:
            avoid = [_clip_text(value, limit=140) for value in item.do_not_repeat[:3]]
            lines.append(
                f"- epoch {item.epoch}: {_clip_text(item.harness_delta_summary)}; "
                f"hard misses={[ _clip_text(value, limit=120) for value in item.hard_rubric_misses[:3] ]}; "
                f"soft={_clip_text(item.soft_regression_summary, limit=160)}; "
                f"root_cause={_clip_text(item.root_cause, limit=180)}; "
                f"avoid={avoid}"
            )
        return "\n".join(lines)


def build_rejection_experience(
    *,
    epoch: int,
    loop_role: str,
    parent: HarnessProfile,
    candidate: HarnessProfile,
    epoch_result: HarnessEpochResult,
    rubric_validation: dict[str, Any] | None,
) -> HarnessRejectionExperience:
    rubric = rubric_validation or {}
    case_results = rubric.get("case_results", [])
    failed_tasks = tuple(
        str(item.get("case_id", ""))
        for item in case_results
        if not item.get("passed", False)
    )
    hard_misses: list[str] = []
    soft_bits: list[str] = []
    for item in case_results:
        if item.get("passed", False):
            continue
        for reason in item.get("reasons", []):
            text = str(reason)
            if "hard rubric" in text:
                hard_misses.append(text)
            if "soft rubric total" in text:
                soft_bits.append(text)
    for reason in epoch_result.reasons:
        text = str(reason)
        if "hard rubric" in text and text not in hard_misses:
            hard_misses.append(text)
        if "soft rubric total" in text and text not in soft_bits:
            soft_bits.append(text)

    added = sorted(set(candidate.active_modules) - set(parent.active_modules))
    removed = sorted(set(parent.active_modules) - set(candidate.active_modules))
    delta_parts = []
    if added:
        delta_parts.append(f"added modules {added}")
    if removed:
        delta_parts.append(f"removed modules {removed}")
    if candidate.context_compiler != parent.context_compiler:
        delta_parts.append("context_compiler changed")
    if candidate.recovery_policy != parent.recovery_policy:
        delta_parts.append("recovery_policy changed")
    if candidate.validation_policy != parent.validation_policy:
        delta_parts.append("validation_policy changed")
    if len(candidate.active_tool_interfaces) != len(parent.active_tool_interfaces):
        delta_parts.append("tool_interfaces changed")

    do_not_repeat = tuple(
        dict.fromkeys(
            [
                *(_clip_text(item, limit=160) for item in hard_misses[:3]),
                _clip_text(candidate.rationale, limit=220),
                *(_clip_text(item, limit=160) for item in epoch_result.reasons[:2]),
            ]
        )
    )
    evidence_refs = tuple(
        str(outcome.run_ref)
        for outcome in epoch_result.candidate_outcomes
        if outcome.run_ref
    )
    return HarnessRejectionExperience(
        epoch=epoch,
        loop_role=loop_role,
        parent_harness_id=parent.harness_id,
        candidate_harness_id=candidate.harness_id,
        harness_delta_summary=(
            "; ".join(delta_parts)
            if delta_parts
            else _clip_text(candidate.rationale, limit=220)
        ),
        failed_tasks=failed_tasks or tuple(str(item) for item in epoch_result.reasons[:3]),
        hard_rubric_misses=tuple(hard_misses),
        soft_regression_summary=_clip_text(
            " | ".join(soft_bits) or "soft total regressed",
            limit=220,
        ),
        root_cause=_clip_text(
            "; ".join(epoch_result.reasons[:4]) or "admission rejected",
            limit=260,
        ),
        do_not_repeat=do_not_repeat,
        evidence_refs=evidence_refs,
    )


def summarize_experiences(
    experiences: Sequence[HarnessRejectionExperience],
) -> tuple[str, ...]:
    return tuple(item.do_not_repeat[0] for item in experiences if item.do_not_repeat)
