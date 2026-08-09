from __future__ import annotations

from typing import Any, Sequence

from game_loop.core.models import AttemptRecord, EvaluationResult, MutationIntent


def compile_neutral_feedback(
    *,
    run_id: str,
    generation: int,
    candidate_index: int,
    parent_artifact_id: str,
    intent: MutationIntent,
) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "run_id": run_id,
        "generation": generation,
        "candidate_index": candidate_index,
        "parent_artifact_id": parent_artifact_id,
        "feedback_disclosure": "NONE",
        "observation_sources": ["mandatory_validity_gates"],
        "objective": "Produce the strongest valid artifact under the benchmark's real constraints.",
        "facts": {},
        "priority": {"intent": intent.to_dict()},
        "recent_attempts": [],
    }


def compile_feedback(
    *,
    run_id: str,
    generation: int,
    candidate_index: int,
    parent_artifact_id: str,
    parent: EvaluationResult,
    history: Sequence[AttemptRecord],
    intent: MutationIntent,
    disclosure_level: str,
    method_level: str,
    fixed_probe_observations: list[dict] | None = None,
    active_probe_selection: dict[str, Any] | None = None,
    agent_harness: dict[str, Any] | None = None,
    context_compiler: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sources = ["benchmark_evaluator", "mandatory_validity_gates"]
    if method_level == "L1":
        sources.insert(1, "configuration_frozen_fixed_probes")
    elif method_level in {"L2", "L3", "L4"}:
        sources.insert(
            1,
            "actively_selected_frozen_probe_catalog"
            if method_level == "L2"
            else "coevolving_bounded_probe_archive",
        )
    if method_level == "L4" and agent_harness is not None:
        sources.insert(1, "episode_frozen_agent_harness")

    facts: dict[str, Any] = {}
    if disclosure_level in {"OBJECTIVES", "DIAGNOSTICS"}:
        facts["feasible"] = parent.feasible
        facts["primary_score"] = parent.primary_score
        facts["objectives"] = dict(parent.objectives)
        facts["constraints"] = dict(parent.constraints)
    if disclosure_level == "DIAGNOSTICS":
        facts["diagnostics"] = list(parent.diagnostics)
    if method_level == "L1" and fixed_probe_observations is not None:
        facts["fixed_probe_observations"] = fixed_probe_observations
    if method_level in {"L2", "L3", "L4"} and fixed_probe_observations is not None:
        facts["active_probe_observations"] = fixed_probe_observations

    priority: dict[str, Any] = {"intent": intent.to_dict()}
    if active_probe_selection is not None:
        priority["active_probe_selection"] = active_probe_selection

    feedback = {
        "schema_version": "1.0",
        "run_id": run_id,
        "generation": generation,
        "candidate_index": candidate_index,
        "parent_artifact_id": parent_artifact_id,
        "episode_mode": "generation",
        "feedback_disclosure": disclosure_level,
        "method_level": method_level,
        "observation_sources": sources,
        "objective": "Produce the strongest valid game output under the benchmark's real constraints.",
        "facts": facts,
        "priority": priority,
        "recent_attempts": _recent_attempts(history, context_compiler),
    }
    if agent_harness is not None:
        feedback["agent_harness"] = agent_harness
    if context_compiler is not None:
        feedback["context_compiler"] = context_compiler
    return feedback


def _recent_attempts(
    history: Sequence[AttemptRecord],
    context_compiler: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    window = 5
    if context_compiler is not None:
        window = int(context_compiler.get("history_window", window))
    if window <= 0:
        return []
    items: list[dict[str, Any]] = []
    for attempt in history[-window:]:
        items.append({
            "attempt_id": attempt.attempt_id,
            "status": attempt.status,
            "accepted": attempt.accepted,
            "primary_score": attempt.primary_score,
            "reasons": list(attempt.reasons[:3]),
            "intent_kind": attempt.intent_kind,
        })
    return items
