from __future__ import annotations

from typing import Any, Mapping


def decide_paired_admission(
    evaluation: Mapping[str, Any] | None,
    *,
    material_change: bool,
    minimum_delta: float = 0.0,
) -> dict[str, Any]:
    """Apply the fail-closed promotion gate for continuation artifacts."""

    reasons: list[str] = []
    payload = dict(evaluation or {})
    infrastructure_ok = payload.get("infrastructure_ok") is True
    parent_score = payload.get("parent_score")
    candidate_score = payload.get("candidate_score")
    hard_regression = payload.get("hard_regression") is True or bool(
        payload.get("hard_regressions")
    )

    if not material_change:
        reasons.append("candidate has no substantive implementation or asset change")
    if not infrastructure_ok:
        reasons.append("paired evaluator infrastructure is unavailable or incomplete")
    if parent_score is None or candidate_score is None:
        reasons.append("paired parent/candidate score is missing")
        delta = None
    else:
        try:
            parent_score = float(parent_score)
            candidate_score = float(candidate_score)
            delta = candidate_score - parent_score
        except (TypeError, ValueError):
            delta = None
            reasons.append("paired parent/candidate score is invalid")
    if delta is not None and delta <= float(minimum_delta):
        reasons.append(
            f"candidate did not strictly improve score: delta={delta:.6f}, "
            f"required>{float(minimum_delta):.6f}"
        )
    if hard_regression:
        reasons.append("candidate has a hard gameplay, charter, visual, or reliability regression")
    if payload.get("passed") is not True:
        reasons.append("paired evaluator did not mark the comparison as passed")

    return {
        "method": "strict-paired-quality-gate-v1",
        "accepted": not reasons,
        "infrastructure_ok": infrastructure_ok,
        "parent_score": parent_score,
        "candidate_score": candidate_score,
        "delta": delta,
        "minimum_delta": float(minimum_delta),
        "hard_regression": hard_regression,
        "reasons": reasons,
        "evaluator": payload,
    }
