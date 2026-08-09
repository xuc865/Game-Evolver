from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Sequence

from game_loop.config import ActiveProbeSelectionConfig, FixedProbeConfig

from .models import AttemptRecord, MutationIntent


@dataclass(frozen=True)
class ProbeSelectionDecision:
    policy_version: str
    generation: int
    candidate_index: int
    selected_probe_ids: tuple[str, ...]
    priorities: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["selected_probe_ids"] = list(self.selected_probe_ids)
        value["priorities"] = list(self.priorities)
        return value


class ActiveProbeSelector:
    policy_version = "coverage-regression-uncertainty-intent-v1"

    def select(
        self,
        *,
        catalog: Sequence[FixedProbeConfig],
        policy: ActiveProbeSelectionConfig,
        history: Sequence[AttemptRecord],
        intent: MutationIntent,
        generation: int,
        candidate_index: int,
    ) -> ProbeSelectionDecision:
        stats = _probe_stats(history)
        required = [probe for probe in catalog if probe.selection_mode == "required"]
        optional = [probe for probe in catalog if probe.selection_mode != "required"]
        slots = max(0, policy.max_selected_probes - len(required))
        scored = sorted(
            (
                _score_probe(
                    probe,
                    policy=policy,
                    stats=stats.get(probe.probe_id, _empty_stats()),
                    intent=intent,
                    generation=generation,
                    candidate_index=candidate_index,
                )
                for probe in optional
            ),
            key=lambda item: (-item["priority"], item["probe_id"]),
        )
        selected_optional = [item["probe_id"] for item in scored[:slots]]
        selected = tuple(probe.probe_id for probe in required) + tuple(selected_optional)
        priorities = tuple(
            _priority_entry(probe, selected=(probe.probe_id in selected), stats=stats, policy=policy, intent=intent)
            for probe in catalog
        )
        return ProbeSelectionDecision(
            policy_version=self.policy_version,
            generation=generation,
            candidate_index=candidate_index,
            selected_probe_ids=selected,
            priorities=priorities,
        )


class UniformProbeSelector:
    policy_version = "uniform-round-robin-v1"

    def select(
        self,
        *,
        catalog: Sequence[FixedProbeConfig],
        policy: ActiveProbeSelectionConfig,
        history: Sequence[AttemptRecord],
        intent: MutationIntent,
        generation: int,
        candidate_index: int,
    ) -> ProbeSelectionDecision:
        del history, intent
        required = [probe.probe_id for probe in catalog if probe.selection_mode == "required"]
        optional = [probe.probe_id for probe in catalog if probe.selection_mode != "required"]
        slots = max(0, policy.max_selected_probes - len(required))
        selected_optional: list[str] = []
        if optional and slots:
            index = (generation - 1) % len(optional)
            for offset in range(slots):
                selected_optional.append(optional[(index + offset) % len(optional)])
        selected = tuple(required + selected_optional)
        priorities = tuple({
            "probe_id": probe.probe_id,
            "selected": probe.probe_id in selected,
            "required": probe.selection_mode == "required",
            "priority": 1.0,
            "reason": "uniform round-robin selection",
        } for probe in catalog)
        return ProbeSelectionDecision(
            policy_version=self.policy_version,
            generation=generation,
            candidate_index=candidate_index,
            selected_probe_ids=selected,
            priorities=priorities,
        )


def selected_probes(
    catalog: Sequence[FixedProbeConfig],
    decision: ProbeSelectionDecision,
) -> tuple[FixedProbeConfig, ...]:
    by_id = {probe.probe_id: probe for probe in catalog}
    return tuple(by_id[probe_id] for probe_id in decision.selected_probe_ids if probe_id in by_id)


def _empty_stats() -> dict[str, Any]:
    return {
        "observations": 0,
        "regressions_found": 0,
        "last_selected_attempt": None,
    }


def _probe_stats(history: Sequence[AttemptRecord]) -> dict[str, dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = {}
    for attempt in history:
        summary = attempt.probe_summary or {}
        selected = summary.get("selected_probe_ids") or []
        parent = {item["probe_id"]: item for item in summary.get("parent", [])}
        candidate = {item["probe_id"]: item for item in summary.get("candidate", [])}
        for probe_id in selected:
            entry = stats.setdefault(probe_id, _empty_stats())
            entry["observations"] += 1
            entry["last_selected_attempt"] = attempt.attempt_id
            before = parent.get(probe_id)
            after = candidate.get(probe_id)
            if (
                before is not None
                and after is not None
                and before.get("passed") is True
                and after.get("passed") is not True
            ):
                entry["regressions_found"] += 1
    return stats


def _score_probe(
    probe: FixedProbeConfig,
    *,
    policy: ActiveProbeSelectionConfig,
    stats: dict[str, Any],
    intent: MutationIntent,
    generation: int,
    candidate_index: int,
) -> dict[str, Any]:
    del generation, candidate_index
    observations = int(stats["observations"])
    regressions = int(stats["regressions_found"])
    warmup_deficit = max(0, policy.min_observations_per_probe - observations)
    coverage = 1.0 if warmup_deficit > 0 else 0.0
    regression_yield = regressions / max(observations, 1)
    uncertainty = 1.0 / (1.0 + observations)
    intent_tags = {intent.kind, intent.target or ""}
    intent_tags.update(intent.preserve)
    probe_tags = set(probe.tags)
    intent_affinity = len(intent_tags & probe_tags) / max(len(probe_tags), 1)
    recency = 1.0 if stats["last_selected_attempt"] is None else 0.25
    priority = (
        policy.coverage_weight * coverage
        + policy.regression_weight * regression_yield
        + policy.uncertainty_weight * uncertainty
        + policy.intent_affinity_weight * intent_affinity
        + policy.recency_weight * recency
        + warmup_deficit
    )
    reason = (
        "selected to close the frozen-catalog coverage deficit"
        if warmup_deficit > 0
        else "selected for regression yield"
        if regressions > 0
        else "selected for balanced active observation"
    )
    return {
        "probe_id": probe.probe_id,
        "priority": priority,
        "reason": reason,
        "observations": observations,
        "regressions_found": regressions,
        "warmup_deficit": warmup_deficit,
        "coverage": coverage,
        "regression_yield": regression_yield,
        "uncertainty": uncertainty,
        "intent_affinity": intent_affinity,
        "recency": recency,
    }


def _priority_entry(
    probe: FixedProbeConfig,
    *,
    selected: bool,
    stats: dict[str, dict[str, Any]],
    policy: ActiveProbeSelectionConfig,
    intent: MutationIntent,
) -> dict[str, Any]:
    if probe.selection_mode == "required":
        return {
            "probe_id": probe.probe_id,
            "selected": True,
            "required": True,
            "observations": stats.get(probe.probe_id, _empty_stats())["observations"],
            "regressions_found": stats.get(probe.probe_id, _empty_stats())["regressions_found"],
            "last_selected_attempt": stats.get(probe.probe_id, _empty_stats())["last_selected_attempt"],
            "coverage": 1.0,
            "regression_yield": 0.0,
            "uncertainty": 0.0,
            "intent_affinity": 1.0,
            "recency": 1.0,
            "warmup_deficit": 0,
            "priority": 1_000_000_000.0,
            "reason": "required probe is always selected",
        }
    scored = _score_probe(
        probe,
        policy=policy,
        stats=stats.get(probe.probe_id, _empty_stats()),
        intent=intent,
        generation=0,
        candidate_index=0,
    )
    scored["selected"] = selected
    scored["required"] = False
    scored["last_selected_attempt"] = stats.get(probe.probe_id, _empty_stats())["last_selected_attempt"]
    return scored
