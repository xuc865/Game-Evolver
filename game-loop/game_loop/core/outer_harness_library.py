from __future__ import annotations

import ast
import json
import os
import re
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from statistics import median
from typing import Any

from game_loop.config import HarnessElementConfig
from game_loop.core.harness import HarnessEpochResult, HarnessProfile
from game_loop.core.harness_element_stats import (
    ELEMENT_CATEGORIES,
    ElementStat,
    HarnessElementStatsStore,
    element_similarity,
    element_stat_key,
    inner_harness_score_and_hard_regression,
)
from game_loop.utils import atomic_write_json, read_json, utc_now

OUTER_LIBRARY_OPERATIONS = frozenset({"add", "delete", "modify", "merge", "unchanged"})

_SUBAGENT_PERSONA_CLAUSES = (
    "Use when:",
    "Scope:",
    "Deliverable:",
    "Done when:",
    "Return:",
)


def _validate_evolved_subagent_persona(element: HarnessElementConfig) -> None:
    """Keep HPA-generated fork targets legible without evolving fork policy."""

    if element.category != "subagent":
        return
    persona = str(element.spec.get("persona", ""))
    missing = [clause for clause in _SUBAGENT_PERSONA_CLAUSES if clause not in persona]
    if missing:
        raise ValueError(
            "evolved subagent persona lacks delegation contract clauses: "
            + ", ".join(missing)
        )


def _subagent_persona_contract_valid(element: HarnessElementConfig) -> bool:
    if element.category != "subagent":
        return True
    try:
        _validate_evolved_subagent_persona(element)
    except ValueError:
        return False
    return True


def _validate_non_coercive_delegation(element: HarnessElementConfig) -> None:
    """Reject library objects that manufacture fork evidence instead of value."""

    text = json.dumps({
        "description": element.description,
        "spec": element.spec,
        "tags": element.tags,
    }, ensure_ascii=False).casefold()
    delegation_terms = (
        "fork tool",
        "fork-tool",
        "fork invocation",
        "subagent invocation",
        "child invocation",
    )
    coercion_terms = (
        "at least one",
        "must invoke",
        "must call",
        "ensure that",
        "verify that",
        "invocation quota",
    )
    metric_terms = (
        "trajectory",
        "admission",
        "acceptance",
        "call evidence",
        "invocation evidence",
    )
    if (
        any(term in text for term in delegation_terms)
        and any(term in text for term in coercion_terms)
        and any(term in text for term in metric_terms)
    ):
        raise ValueError(
            "harness elements may not force or quota child invocation to manufacture "
            "trajectory/admission evidence; delegation must follow marginal value"
        )


def _simple_evolution_contract() -> dict[str, Any]:
    """Describe behavior-level choices without exposing runtime machinery."""

    return {
        "decision": (
            "Choose the smallest reusable behavior change supported by the evidence."
        ),
        "operations": {
            "add": "Create one missing reusable object.",
            "modify": "Improve one disclosed object while preserving its id and category.",
            "merge": "Combine two overlapping disclosed objects.",
            "delete": "Remove one proven harmful object that modification cannot repair.",
        },
        "categories": {
            "context": "Information the builder should receive.",
            "skill": "A reusable reasoning capability.",
            "tool": "An executable inspection or action capability.",
            "protocol": "A reusable invariant or safety boundary.",
            "workflow": "A reusable ordered procedure.",
            "subagent": {
                "purpose": "One reusable bounded job that a child agent can perform.",
                "required_spec": ["persona"],
                "persona_contract": {
                    "Use when:": (
                        "Reusable observable task-structure conditions such as an existing "
                        "bounded artifact boundary, locally runnable acceptance checks, and "
                        "competing independent required slices. Do not use a subjective phrase "
                        "such as 'clear marginal value' that presupposes unknown utility. A "
                        "slice may rely on an existing shared interface; local validation need "
                        "not prove that later whole-artifact integration is unnecessary."
                    ),
                    "Scope:": (
                        "One bounded class of work and, when implementation is delegated, "
                        "the explicit artifact slice the child owns for this call."
                    ),
                    "Deliverable:": "One independently useful output the root can integrate.",
                    "Done when:": "Observable completion and validation evidence.",
                    "Return:": "The concise handoff payload returned to the root.",
                },
                "rule": (
                    "Write all five labeled clauses inside the single persona string. Keep the "
                    "capability reusable across tasks: do not name a benchmark, product, game, "
                    "task instance, source file, fixed team role, or topology. The runtime "
                    "automatically creates and mounts its fork tool. Do not configure fork "
                    "mechanics or root delegation policy. Do not make every child advisory-only "
                    "or prohibit all child writes by default: when evidence supports delegated "
                    "implementation, the child may directly produce and validate only its "
                    "explicitly assigned artifact slice, while the root retains integration, "
                    "whole-artifact verification, and final delivery. The root may adapt shared "
                    "interfaces or consumers after handoff; do not require a child slice to be "
                    "globally integration-free."
                ),
                "non_coercion": (
                    "Never force, quota, or pre-commit to a child invocation merely to create "
                    "trajectory, admission, or attribution evidence. Delegation must emerge "
                    "from the evolved use condition and expected marginal value."
                ),
                "non_adoption_repair": (
                    "When formal non-adoption evidence identifies an existing prototype, "
                    "repair that prototype with modify. Do not add a sibling replacement "
                    "with the same capability boundary."
                ),
            },
        },
    }


def _outer_dynamics_mode() -> bool:
    return os.environ.get("GAME_LOOP_OUTER_LIBRARY_DYNAMICS_MODE", "").casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _outer_dynamics_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _element_payload(spec: HarnessElementConfig) -> dict[str, Any]:
    return {
        "id": spec.element_id,
        "category": spec.category,
        "description": spec.description,
        "spec": dict(spec.spec),
        "tags": list(spec.tags),
    }


def _extract_json_object(text: str) -> dict[str, Any]:
    value = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", value, re.DOTALL)
    if fenced:
        value = fenced.group(1)
    else:
        balanced = _extract_balanced_object(value)
        if balanced:
            value = balanced
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        repaired = _repair_llm_json_object(value)
        try:
            parsed = json.loads(repaired)
        except json.JSONDecodeError:
            repaired = _repair_bare_json_values(repaired)
            try:
                parsed = json.loads(repaired)
            except json.JSONDecodeError:
                literal_value = re.sub(
                    r"\btrue\b", "True", repaired, flags=re.IGNORECASE
                )
                literal_value = re.sub(
                    r"\bfalse\b", "False", literal_value, flags=re.IGNORECASE
                )
                literal_value = re.sub(
                    r"\bnull\b", "None", literal_value, flags=re.IGNORECASE
                )
                parsed = _safe_literal_eval_with_names(literal_value)
    if not isinstance(parsed, dict):
        raise TypeError("outer library agent must return one JSON object")
    try:
        # ``ast.Constant`` also represents Python's Ellipsis.  It is inert, but
        # not JSON data; accepting it here lets a schema placeholder such as
        # ``additions: [...]`` fail much later while persisting the epoch audit.
        # Reject every non-JSON value at the parser boundary so the configured
        # backbone retry can request a corrected payload.
        json.dumps(parsed, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"outer library payload is not JSON-serializable: {exc}") from exc
    return parsed


def _extract_balanced_object(value: str) -> str | None:
    start = value.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(value)):
        char = value[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return value[start : index + 1]
    return None


def _repair_llm_json_object(value: str) -> str:
    """Repair narrow JSON formatting slips without changing field content."""
    repaired = re.sub(r",\s*([}\]])", r"\1", value)
    repaired = re.sub(
        r'([}\]"\d])\s*\n(\s*"[A-Za-z0-9_ -]+"\s*:)',
        r"\1,\n\2",
        repaired,
    )
    return re.sub(
        r'([{,]\s*)([A-Za-z_][A-Za-z0-9_ -]*)(\s*:)',
        r'\1"\2"\3',
        repaired,
    )


def _repair_bare_json_values(value: str) -> str:
    """Quote bare scalar values only where the JSON parser expects a value."""
    repaired = value
    for _ in range(32):
        try:
            json.loads(repaired)
            return repaired
        except json.JSONDecodeError as exc:
            if exc.msg != "Expecting value":
                return repaired
            suffix = repaired[exc.pos :]
            match = re.match(r"([A-Za-z_][A-Za-z0-9_.-]*)(?=\s*[,}\]])", suffix)
            if not match:
                return repaired
            token = match.group(1)
            if token.casefold() in {"true", "false", "null"}:
                return repaired
            repaired = (
                repaired[: exc.pos]
                + json.dumps(token)
                + repaired[exc.pos + len(token) :]
            )
    return repaired


def _safe_literal_eval_with_names(value: str) -> Any:
    """Evaluate a data literal while treating bare enum names as strings."""
    root = ast.parse(value, mode="eval").body

    def decode(node: ast.AST) -> Any:
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.List):
            return [decode(item) for item in node.elts]
        if isinstance(node, ast.Tuple):
            return tuple(decode(item) for item in node.elts)
        if isinstance(node, ast.Set):
            # Normalize inert Python set syntax into JSON-compatible data.
            return [decode(item) for item in node.elts]
        if isinstance(node, ast.Dict):
            return {decode(key): decode(item) for key, item in zip(node.keys, node.values)}
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            operand = decode(node.operand)
            if not isinstance(operand, (int, float, complex)):
                raise ValueError("unary literal operand must be numeric")
            return operand if isinstance(node.op, ast.UAdd) else -operand
        raise ValueError(
            f"unsupported node in outer library data literal: {type(node).__name__}"
        )

    return decode(root)


def _compact_inner_epoch_result(result: HarnessEpochResult) -> dict[str, Any]:
    """Keep outer-loop evidence bounded without dropping admission signals."""
    value = result.to_dict()
    compact: dict[str, Any] = {
        "epoch": value.get("epoch"),
        "parent_harness_id": value.get("parent_harness_id"),
        "candidate_harness_id": value.get("candidate_harness_id"),
        "accepted": value.get("accepted"),
        "paired_deltas": list(value.get("paired_deltas") or [])[:8],
        "median_delta": value.get("median_delta"),
        "reasons": list(value.get("reasons") or [])[:6],
        "excluded_pairs": list(value.get("excluded_pairs") or [])[:6],
        "parent_outcomes": [],
        "candidate_outcomes": [],
    }
    for side in ("parent_outcomes", "candidate_outcomes"):
        compact[side] = [
            {
                key: outcome.get(key)
                for key in (
                    "case_id",
                    "harness_id",
                    "final_score",
                    "feasible",
                    "infrastructure_ok",
                    "model_calls",
                    "evaluator_queries",
                    "run_ref",
                )
                if key in outcome
            }
            for outcome in (value.get(side) or [])[:8]
            if isinstance(outcome, dict)
        ]
    rubric = value.get("rubric_validation")
    if isinstance(rubric, dict):
        compact["rubric_validation"] = {
            key: rubric.get(key)
            for key in (
                "accepted",
                "infrastructure_ok",
                "hard_regression",
                "hard_score",
                "soft_score",
                "overall_score",
                "median_delta",
                "reasons",
            )
            if key in rubric
        }
        compact["rubric_validation"]["candidate_score_gaps"] = (
            _compact_candidate_score_gaps(rubric)
        )
    return compact


def _compact_candidate_score_gaps(rubric: dict[str, Any]) -> list[dict[str, Any]]:
    """Expose accepted-but-imperfect rubric dimensions as improvement evidence."""
    gaps: list[dict[str, Any]] = []
    for comparison in rubric.get("case_results") or []:
        if not isinstance(comparison, dict):
            continue
        candidate = comparison.get("candidate")
        if not isinstance(candidate, dict) or candidate.get("infrastructure_ok") is False:
            continue
        soft = candidate.get("soft")
        if not isinstance(soft, dict):
            soft = {}
        underperforming = {
            str(rubric_id): float(score)
            for rubric_id, score in soft.items()
            if isinstance(score, (int, float)) and float(score) < 1.0 - 1e-9
        }
        soft_total = candidate.get("soft_total")
        if not underperforming and not (
            isinstance(soft_total, (int, float))
            and float(soft_total) < 1.0 - 1e-9
        ):
            continue
        gaps.append({
            "case_id": comparison.get("case_id"),
            "candidate_soft_total": soft_total,
            "underperforming_soft_rubrics": underperforming,
        })
    return gaps[:8]


def _evidence_epoch_sets(
    *,
    latest_inner_result: HarnessEpochResult,
    inner_history: list[dict[str, Any]],
) -> tuple[set[int], set[int], set[int]]:
    """Collect formal failure/gap epochs before asking HPA for an actionable plan."""

    failed_history_epochs: set[int] = set()
    failed_outer_library_epochs: set[int] = set()
    imperfect_score_epochs: set[int] = set()
    if not latest_inner_result.accepted:
        failed_history_epochs.add(latest_inner_result.epoch)
    latest_rubric = latest_inner_result.rubric_validation
    if (
        isinstance(latest_rubric, dict)
        and latest_rubric.get("infrastructure_ok") is True
        and _compact_candidate_score_gaps(latest_rubric)
    ):
        imperfect_score_epochs.add(latest_inner_result.epoch)
    for item in inner_history:
        if not isinstance(item, dict):
            continue
        inner = item.get("inner")
        if isinstance(inner, dict):
            raw_epoch = inner.get("epoch")
            accepted = inner.get("accepted")
            rubric = inner.get("rubric_validation")
            inner_evidence = inner
        else:
            raw_epoch = item.get("epoch")
            accepted = item.get("accepted")
            rubric = item.get("rubric_validation")
            inner_evidence = item
        infrastructure_ok = (
            rubric.get("infrastructure_ok")
            if isinstance(rubric, dict)
            else None
        )
        outcomes = [
            outcome
            for side in ("parent_outcomes", "candidate_outcomes")
            for outcome in (inner_evidence.get(side) or [])
            if isinstance(outcome, dict)
        ]
        if any(outcome.get("infrastructure_ok") is False for outcome in outcomes):
            infrastructure_ok = False
        if (
            isinstance(raw_epoch, int)
            and accepted is False
            and infrastructure_ok is True
        ):
            failed_history_epochs.add(raw_epoch)
        if (
            isinstance(raw_epoch, int)
            and infrastructure_ok is True
            and isinstance(rubric, dict)
            and _compact_candidate_score_gaps(rubric)
        ):
            imperfect_score_epochs.add(raw_epoch)
        library_update = item.get("outer_element_library_update")
        if isinstance(library_update, dict):
            update_payload = library_update.get("library_update", library_update)
            update_status = update_payload.get("status")
        else:
            update_status = None
        if update_status is None:
            outer = item.get("outer") if isinstance(item.get("outer"), dict) else {}
            validation = outer.get("rubric_validation") if isinstance(outer, dict) else {}
            if isinstance(validation, dict):
                nested_update = validation.get("library_update")
                if isinstance(nested_update, dict):
                    update_status = nested_update.get("status")
        if (
            isinstance(raw_epoch, int)
            and update_status == "failed_infrastructure_or_validation"
        ):
            failed_outer_library_epochs.add(raw_epoch)
    return (
        failed_history_epochs,
        failed_outer_library_epochs,
        imperfect_score_epochs,
    )


def _normalize_element_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result = dict(value)
    if "id" not in result and "element_id" in result:
        result["id"] = result["element_id"]
    return result


def _normalize_outer_plan(plan: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(plan, dict):
        raise ValueError("outer plan must be an object")
    result = dict(plan)

    # Some planners return one complete addition payload at the plan root while
    # also emitting empty operations/additions arrays. Treat that as a schema
    # alias only when every admission field is present; apply_plan still checks
    # evidence epochs, duplication, categories, and transaction safety.
    root_element_id = result.get("id") or result.get("element_id")
    root_looks_like_element = bool(
        root_element_id and {"category", "description", "spec"} <= set(result)
    )
    if (
        not (result.get("additions") or [])
        and root_looks_like_element
        and not str(result.get("capability_boundary_evidence", "")).strip()
    ):
        raise ValueError(
            "root-level element addition requires capability_boundary_evidence and "
            "supporting_epoch_ids"
        )
    if (
        not (result.get("additions") or [])
        and root_looks_like_element
        and str(result.get("capability_boundary_evidence", "")).strip()
    ):
        root_addition = {
            "operation": "add",
            "capability_boundary_evidence": result["capability_boundary_evidence"],
            "supporting_epoch_ids": result.get("supporting_epoch_ids", []),
            "element": _normalize_element_payload({
                "id": root_element_id,
                "category": result["category"],
                "description": result["description"],
                "spec": result.get("spec", {}),
                "tags": result.get("tags", []),
            }),
        }
        result["additions"] = [root_addition]

    if not (result.get("operations") or result.get("additions")):
        allowed_noop_keys = {
            "operations",
            "additions",
            "rationale",
            "reason",
            "no_change_rationale",
        }
        unwrapped_fields = sorted(set(result) - allowed_noop_keys)
        if unwrapped_fields:
            raise ValueError(
                "outer plan contains object content without an add/modify/merge/delete "
                "action; wrap the intended change in operations or additions: "
                + ", ".join(unwrapped_fields)
            )

    operations = result.get("operations", [])
    promoted_additions = []
    if isinstance(operations, list):
        normalized_operations = []
        for raw in operations:
            if not isinstance(raw, dict):
                normalized_operations.append(raw)
                continue
            item = dict(raw)
            if "element_id" not in item and "id" in item:
                item["element_id"] = item["id"]
            if str(item.get("operation", "")).casefold() == "add":
                if {"category", "description"} <= set(item):
                    addition = dict(item)
                    addition.pop("operation", None)
                    addition["operation"] = "add"
                    addition["element"] = _normalize_element_payload(addition)
                    if (
                        "capability_boundary_evidence" not in addition
                        and str(addition.get("reason", "")).strip()
                    ):
                        addition["capability_boundary_evidence"] = addition["reason"]
                    promoted_additions.append(addition)
                    continue
                item["operation"] = "unchanged"
                item["reason"] = (
                    str(item.get("reason", "")).strip()
                    or "operation=add for an existing element was treated as unchanged"
                )
            if "replacement" in item:
                item["replacement"] = _normalize_element_payload(item.get("replacement"))
            if "merged_element" in item:
                item["merged_element"] = _normalize_element_payload(
                    item.get("merged_element")
                )
            normalized_operations.append(item)
        result["operations"] = normalized_operations

    additions = [*promoted_additions, *(result.get("additions", []) or [])]
    if isinstance(additions, list):
        normalized_additions = []
        for raw in additions:
            if not isinstance(raw, dict):
                normalized_additions.append(raw)
                continue
            item = dict(raw)
            if "element" in item:
                item["element"] = _normalize_element_payload(item.get("element"))
            elif (
                {"id", "category", "description"} <= set(item)
                or {"element_id", "category", "description"} <= set(item)
            ):
                item["element"] = _normalize_element_payload(item)
            if (
                "capability_boundary_evidence" not in item
                and str(item.get("reason", "")).strip()
            ):
                item["capability_boundary_evidence"] = item["reason"]
            supporting_epochs = item.get("supporting_epoch_ids")
            if isinstance(supporting_epochs, list):
                converted = []
                for epoch in supporting_epochs:
                    if isinstance(epoch, int):
                        converted.append(epoch)
                    elif isinstance(epoch, str):
                        token = epoch.strip()
                        match = re.fullmatch(r"(?:epoch[_:/-]*)?(\d+)", token, re.I)
                        converted.append(int(match.group(1)) if match else epoch)
                    else:
                        converted.append(epoch)
                item["supporting_epoch_ids"] = converted
            normalized_additions.append(item)
        result["additions"] = normalized_additions

    return result


def _clip_history_text(value: Any, *, limit: int = 240) -> str:
    text = " ".join(str(value).split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def _compact_outer_inner_history(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        inner = item.get("inner") if isinstance(item.get("inner"), dict) else item
        outer = item.get("outer") if isinstance(item.get("outer"), dict) else {}
        library_update = item.get("outer_element_library_update")
        if isinstance(library_update, dict):
            library_update = library_update.get("library_update")
        if not isinstance(library_update, dict):
            outer_validation = outer.get("rubric_validation") if isinstance(outer, dict) else {}
            if isinstance(outer_validation, dict):
                library_update = outer_validation.get("library_update")
        if not isinstance(library_update, dict):
            library_update = {}

        changed_ops = []
        for op in library_update.get("operations") or []:
            if not isinstance(op, dict):
                continue
            operation = str(op.get("operation", ""))
            if operation and operation != "unchanged":
                changed_ops.append({
                    "element_id": op.get("element_id"),
                    "operation": operation,
                    "reason": _clip_history_text(op.get("reason", ""), limit=120),
                })
        additions = []
        for addition in library_update.get("additions") or []:
            if not isinstance(addition, dict):
                continue
            element = addition.get("element") if isinstance(addition.get("element"), dict) else {}
            additions.append({
                "element_id": element.get("id") or element.get("element_id"),
                "category": element.get("category"),
                "evidence": _clip_history_text(
                    addition.get("capability_boundary_evidence", ""),
                    limit=120,
                ),
            })

        rubric = inner.get("rubric_validation") if isinstance(inner, dict) else {}
        compact.append({
            "epoch": inner.get("epoch"),
            "accepted": inner.get("accepted"),
            "parent_harness_id": inner.get("parent_harness_id"),
            "candidate_harness_id": inner.get("candidate_harness_id"),
            "median_delta": inner.get("median_delta"),
            "reasons": [
                _clip_history_text(reason, limit=160)
                for reason in (inner.get("reasons") or [])[:4]
            ],
            "excluded_pairs": [
                _clip_history_text(reason, limit=120)
                for reason in (inner.get("excluded_pairs") or [])[:3]
            ],
            "rubric_infrastructure_ok": (
                rubric.get("infrastructure_ok") if isinstance(rubric, dict) else None
            ),
            "candidate_score_gaps": (
                _compact_candidate_score_gaps(rubric)
                if isinstance(rubric, dict)
                else []
            ),
            "outer_library_status": library_update.get("status"),
            "outer_library_error": _clip_history_text(
                library_update.get("error", ""),
                limit=180,
            ),
            "outer_shortlist": list(library_update.get("shortlist") or [])[:8],
            "outer_changed_operations": changed_ops[:8],
            "outer_additions": additions[:4],
        })
    return compact


def _element_content_similarity(
    left: HarnessElementConfig,
    right: HarnessElementConfig,
) -> float:
    if left.category != right.category:
        return 0.0

    def tokens(spec: HarnessElementConfig) -> set[str]:
        values: list[str] = [spec.description]

        def collect(value: Any) -> None:
            if isinstance(value, str):
                values.append(value)
            elif isinstance(value, dict):
                for nested in value.values():
                    collect(nested)
            elif isinstance(value, (list, tuple)):
                for nested in value:
                    collect(nested)

        collect(spec.spec)
        content = " ".join(values).casefold()
        return set(re.findall(r"[\w-]+", content, flags=re.UNICODE))

    left_tokens = tokens(left)
    right_tokens = tokens(right)
    return len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))


@dataclass(frozen=True)
class OuterLibraryUpdate:
    epoch: int
    status: str
    revision_before: int
    revision_after: int
    shortlist: tuple[str, ...]
    operations: tuple[dict[str, Any], ...]
    additions: tuple[dict[str, Any], ...]
    next_inner_element_ids: tuple[str, ...] = ()
    error: str | None = None

    @property
    def applied(self) -> bool:
        return self.status in {"applied", "unchanged"}

    def to_dict(self) -> dict[str, Any]:
        return {
            "epoch": self.epoch,
            "status": self.status,
            "revision_before": self.revision_before,
            "revision_after": self.revision_after,
            "shortlist": list(self.shortlist),
            "operations": list(self.operations),
            "additions": list(self.additions),
            "next_inner_element_ids": list(self.next_inner_element_ids),
            "error": self.error,
        }


class OuterHarnessLibraryStore:
    """Persistent outer-loop element catalog with outcome-linked metadata."""

    schema_version = "outer-harness-library.v1"
    disclosure_policy = "progressive_index_then_details"

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.catalog_path = self.root / "catalog.json"
        self.stats_path = self.root / "element_stats.json"
        self.epochs_dir = self.root / "epochs"
        self.usage_dir = self.root / "inner_usage"
        self.transaction_path = self.root / ".catalog_stats_transaction.json"

    def _recover_pending_transaction(self) -> None:
        if not self.transaction_path.is_file():
            return
        transaction = read_json(self.transaction_path)
        before_catalog = transaction.get("before_catalog")
        before_stats = transaction.get("before_stats")
        if isinstance(before_catalog, dict):
            atomic_write_json(self.catalog_path, before_catalog)
        if isinstance(before_stats, dict):
            atomic_write_json(self.stats_path, before_stats)
        self.transaction_path.unlink(missing_ok=True)

    def initialize(self, elements: Iterable[HarnessElementConfig]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self._recover_pending_transaction()
        self.epochs_dir.mkdir(parents=True, exist_ok=True)
        self.usage_dir.mkdir(parents=True, exist_ok=True)
        if not self.catalog_path.is_file():
            catalog = sorted(elements, key=lambda item: (item.category, item.element_id))
            atomic_write_json(
                self.catalog_path,
                {
                    "schema_version": self.schema_version,
                    "disclosure_policy": self.disclosure_policy,
                    "revision": 0,
                    "items": [_element_payload(item) for item in catalog],
                    "created_at": utc_now(),
                    "updated_at": utc_now(),
                },
            )
        stats = HarnessElementStatsStore.load(self.stats_path)
        for spec in self.catalog().values():
            key = element_stat_key(spec.category, spec.element_id)
            stats.items.setdefault(
                key,
                ElementStat(element_id=spec.element_id, category=spec.category),
            )
        stats.save(self.stats_path)

    def revision(self) -> int:
        return int(read_json(self.catalog_path).get("revision", 0))

    def catalog(self) -> dict[str, HarnessElementConfig]:
        raw = read_json(self.catalog_path)
        result: dict[str, HarnessElementConfig] = {}
        for item in raw.get("items", []):
            spec = HarnessElementConfig.from_dict(dict(item))
            if spec.element_id in result:
                raise ValueError(f"duplicate outer element id {spec.element_id}")
            result[spec.element_id] = spec
        return result

    def metadata(self) -> dict[str, dict[str, Any]]:
        stats = HarnessElementStatsStore.load(self.stats_path)
        result: dict[str, dict[str, Any]] = {}
        for element_id, spec in self.catalog().items():
            key = element_stat_key(spec.category, element_id)
            stat = stats.items.get(key, ElementStat(element_id, spec.category))
            result[element_id] = stat.to_dict()
        return result

    def outer_exposure_metadata(self) -> dict[str, dict[str, int]]:
        result: dict[str, dict[str, int]] = defaultdict(lambda: {
            "shortlisted": 0,
            "disclosed": 0,
            "plan_unchanged": 0,
            "plan_delete": 0,
            "plan_modify": 0,
            "plan_merge": 0,
            "applied_delete": 0,
            "applied_modify": 0,
            "applied_merge": 0,
        })
        for path in sorted(self.epochs_dir.glob("epoch_*.json")):
            record = read_json(path)
            update = record.get("update") or {}
            for element_id in update.get("shortlist") or record.get("shortlist") or []:
                result[str(element_id)]["shortlisted"] += 1
            for element in record.get("disclosed_elements") or []:
                if isinstance(element, dict) and element.get("id"):
                    result[str(element["id"])]["disclosed"] += 1
            for decision in (record.get("plan") or {}).get("operations") or []:
                if not isinstance(decision, dict):
                    continue
                element_id = str(decision.get("element_id") or decision.get("id") or "")
                operation = str(decision.get("operation") or "").casefold()
                if element_id and operation in {"unchanged", "delete", "modify", "merge"}:
                    result[element_id][f"plan_{operation}"] += 1
            for decision in update.get("operations") or []:
                if not isinstance(decision, dict):
                    continue
                element_id = str(decision.get("element_id") or "")
                operation = str(decision.get("operation") or "").casefold()
                if element_id and operation in {"delete", "modify", "merge"}:
                    result[element_id][f"applied_{operation}"] += 1
        return {key: dict(value) for key, value in result.items()}

    def progressive_index(self) -> list[dict[str, Any]]:
        metadata = self.metadata()
        exposure = self.outer_exposure_metadata() if _outer_dynamics_mode() else {}
        return [
            {
                "id": spec.element_id,
                "category": spec.category,
                "tags": list(spec.tags),
                "usage": metadata[spec.element_id],
                "outer_exposure": exposure.get(spec.element_id, {}),
            }
            for spec in sorted(
                self.catalog().values(), key=lambda item: (item.category, item.element_id)
            )
        ]

    def details(self, element_ids: Iterable[str]) -> list[dict[str, Any]]:
        catalog = self.catalog()
        requested = tuple(dict.fromkeys(str(item) for item in element_ids))
        unknown = sorted(set(requested) - set(catalog))
        if unknown:
            raise ValueError(f"outer library details requested unknown ids: {unknown}")
        return [_element_payload(catalog[element_id]) for element_id in requested]

    def latest_progressive_selection(self) -> list[dict[str, Any]]:
        """Return only details already disclosed or created by the latest applied epoch."""

        def epoch_number(path: Path) -> int:
            match = re.fullmatch(r"epoch_(\d+)\.json", path.name)
            return int(match.group(1)) if match else -1

        records = sorted(
            self.epochs_dir.glob("epoch_*.json"),
            key=epoch_number,
            reverse=True,
        )
        catalog = self.catalog()
        for path in records:
            record = read_json(path)
            if record.get("status") not in {"applied", "unchanged"}:
                continue
            update = record.get("update") or {}
            if isinstance(update, dict) and "next_inner_element_ids" in update:
                selected = [
                    str(item) for item in update.get("next_inner_element_ids", [])
                ]
                surviving = [
                    item for item in dict.fromkeys(selected) if item in catalog
                ]
                return self.details(surviving)
            selected = [str(item) for item in record.get("shortlist", [])]
            plan = record.get("plan") or {}
            for decision in plan.get("operations", []):
                if not isinstance(decision, dict):
                    continue
                operation = str(decision.get("operation", "")).casefold()
                if operation == "modify":
                    selected.append(str(dict(decision.get("replacement", {})).get("id", "")))
                elif operation == "merge":
                    selected.append(str(dict(decision.get("merged_element", {})).get("id", "")))
            for addition in plan.get("additions", []):
                if isinstance(addition, dict):
                    selected.append(str(dict(addition.get("element", {})).get("id", "")))
            surviving = [item for item in dict.fromkeys(selected) if item in catalog]
            return self.details(surviving)
        return []

    def element_ids_for_inner_proposal(
        self,
        fallback_profile: HarnessProfile,
    ) -> tuple[str, ...]:
        selected = tuple(item["id"] for item in self.latest_progressive_selection())
        if selected:
            return selected
        catalog_ids = set(self.catalog())
        return tuple(
            element.element_id
            for element in fallback_profile.active_elements
            if element.element_id in catalog_ids
        )

    def details_for_inner_proposal(
        self,
        fallback_profile: HarnessProfile,
    ) -> list[dict[str, Any]]:
        return self.details(self.element_ids_for_inner_proposal(fallback_profile))

    def record_inner_epoch(
        self,
        *,
        element_ids: Iterable[str],
        result: HarnessEpochResult,
    ) -> dict[str, Any]:
        requested = tuple(dict.fromkeys(str(item) for item in element_ids))
        catalog = self.catalog()
        unknown = sorted(set(requested) - set(catalog))
        if unknown:
            raise ValueError(f"cannot attribute inner epoch to unknown outer elements: {unknown}")
        score, hard_regression = inner_harness_score_and_hard_regression(result)
        usage_path = self.usage_dir / f"inner_epoch_{result.epoch:03d}.json"
        if usage_path.is_file():
            existing = read_json(usage_path)
            expected = {
                "candidate_harness_id": result.candidate_harness_id,
                "element_ids": list(requested),
            }
            actual = {key: existing.get(key) for key in expected}
            replace_unscored = (
                existing.get("recorded_in_metadata") is False and score is not None
            )
            replace_scored_retry = (
                existing.get("recorded_in_metadata") is True
                and existing.get("candidate_harness_id") != result.candidate_harness_id
                and existing.get("element_ids") == list(requested)
            )
            if actual != expected or replace_unscored or replace_scored_retry:
                if existing.get("recorded_in_metadata") is False or replace_scored_retry:
                    conflict_dir = self.usage_dir / "conflicts"
                    conflict_dir.mkdir(parents=True, exist_ok=True)
                    existing_harness = str(
                        existing.get("candidate_harness_id", "unknown")
                    )[:16]
                    timestamp = (
                        utc_now()
                        .replace("-", "")
                        .replace(":", "")
                        .replace(".", "")
                    )
                    archive_path = (
                        conflict_dir
                        / f"{usage_path.stem}.{existing_harness}.{timestamp}.json"
                    )
                    usage_path.replace(archive_path)
                    if replace_scored_retry:
                        stats = HarnessElementStatsStore.load(self.stats_path)
                        old_score = existing.get("candidate_total_score")
                        for element_id in requested:
                            spec = catalog[element_id]
                            stat = stats.items.get(
                                element_stat_key(spec.category, spec.element_id)
                            )
                            if stat is None or result.epoch not in stat.attributed_inner_epochs:
                                continue
                            stat.usage_count = max(0, stat.usage_count - 1)
                            if existing.get("accepted") is True:
                                stat.success_count = max(0, stat.success_count - 1)
                            if isinstance(old_score, (int, float)):
                                numeric_score = float(old_score)
                                stat.score_count = max(0, stat.score_count - 1)
                                stat.score_total -= numeric_score
                                stat.score_sum_squares -= numeric_score * numeric_score
                            if existing.get("hard_regression") is True:
                                stat.hard_regression_count = max(
                                    0, stat.hard_regression_count - 1
                                )
                                stat.hard_regression_ever = stat.hard_regression_count > 0
                            stat.attributed_inner_epochs.remove(result.epoch)
                        stats.save(self.stats_path)
                else:
                    raise ValueError(
                        f"conflicting outer-element attribution for inner epoch {result.epoch}"
                    )
            else:
                return existing

        record = {
            "schema_version": "outer-element-inner-usage.v1",
            "inner_epoch": result.epoch,
            "candidate_harness_id": result.candidate_harness_id,
            "accepted": result.accepted,
            "element_ids": list(requested),
            "candidate_total_score": score,
            "hard_regression": hard_regression,
            "recorded_in_metadata": score is not None,
            "created_at": utc_now(),
        }
        if score is None:
            atomic_write_json(usage_path, record)
            return record

        stats = HarnessElementStatsStore.load(self.stats_path)
        for element_id in requested:
            spec = catalog[element_id]
            stats.touch(
                category=spec.category,
                element_id=element_id,
                success=result.accepted,
                score=score,
                hard_regression=hard_regression,
                attribution_epoch=result.epoch,
            )
        for spec in self.catalog().values():
            key = element_stat_key(spec.category, spec.element_id)
            stats.items.setdefault(
                key,
                ElementStat(element_id=spec.element_id, category=spec.category),
            )
        stats.save(self.stats_path)
        atomic_write_json(usage_path, record)
        return record

    @staticmethod
    def _is_low_score(
        element_id: str,
        metadata: dict[str, dict[str, Any]],
    ) -> bool:
        stat = metadata[element_id]
        mean = stat.get("score_mean")
        if not isinstance(mean, (int, float)):
            return False
        means = [
            float(item["score_mean"])
            for item in metadata.values()
            if isinstance(item.get("score_mean"), (int, float))
        ]
        return len(means) >= 2 and float(mean) <= median(means)

    def _validate_delete(
        self,
        *,
        element_id: str,
        decision: dict[str, Any],
        metadata: dict[str, dict[str, Any]],
    ) -> None:
        stat = metadata[element_id]
        if _outer_dynamics_mode():
            min_usage = _outer_dynamics_int(
                "GAME_LOOP_OUTER_LIBRARY_DYNAMICS_DELETE_MIN_USAGE",
                0,
            )
            if int(stat.get("usage_count", 0)) < min_usage:
                raise ValueError(f"delete requires at least {min_usage} uses: {element_id}")
            if not str(decision.get("modification_inadequate_reason", "")).strip():
                raise ValueError(
                    f"delete must explain why modification is inadequate: {element_id}"
                )
            evidence = " ".join(
                str(decision.get(key, ""))
                for key in (
                    "reason",
                    "unused_or_dormant_evidence",
                    "modification_inadequate_reason",
                )
            ).casefold()
            if (
                int(stat.get("usage_count", 0)) == 0
                and not any(token in evidence for token in ("unused", "dormant", "zero", "shortlist"))
            ):
                raise ValueError(
                    f"delete zero-use element requires dormant/shortlist evidence: {element_id}"
                )
            return
        if int(stat.get("usage_count", 0)) < 5:
            raise ValueError(f"delete requires at least 5 uses: {element_id}")
        if not self._is_low_score(element_id, metadata):
            raise ValueError(f"delete requires observed low-score evidence: {element_id}")
        if not str(decision.get("modification_inadequate_reason", "")).strip():
            raise ValueError(f"delete must explain why modification is inadequate: {element_id}")

    def _validate_modify(
        self,
        *,
        element_id: str,
        decision: dict[str, Any],
        replacement: HarnessElementConfig,
        current: HarnessElementConfig,
        metadata: dict[str, dict[str, Any]],
        non_adoption_repair: bool = False,
    ) -> None:
        stat = metadata[element_id]
        _validate_evolved_subagent_persona(replacement)
        _validate_non_coercive_delegation(replacement)
        if replacement == current:
            raise ValueError(f"modify replacement must change the element: {element_id}")
        if not str(decision.get("correction_hypothesis", "")).strip():
            raise ValueError(f"modify requires a correction hypothesis: {element_id}")
        if not _subagent_persona_contract_valid(current):
            return
        if current.category == "subagent" and non_adoption_repair:
            return
        if _outer_dynamics_mode():
            min_usage = _outer_dynamics_int(
                "GAME_LOOP_OUTER_LIBRARY_DYNAMICS_MODIFY_MIN_USAGE",
                0,
            )
            if int(stat.get("usage_count", 0)) < min_usage:
                raise ValueError(f"modify requires at least {min_usage} uses: {element_id}")
            return
        if int(stat.get("usage_count", 0)) < 3:
            raise ValueError(f"modify requires at least 3 uses: {element_id}")
        if (
            not self._is_low_score(element_id, metadata)
            and stat.get("hard_regression_ever") is not True
        ):
            raise ValueError(f"modify lacks near-deletion evidence: {element_id}")

    def _dynamics_next_inner_ids(
        self,
        *,
        epoch: int,
        shortlist: tuple[str, ...],
        current_inner_ids: tuple[str, ...],
        catalog: dict[str, HarnessElementConfig],
        added_ids: list[str],
    ) -> list[str]:
        max_ids = max(1, _outer_dynamics_int(
            "GAME_LOOP_OUTER_LIBRARY_DYNAMICS_SELECTION_SIZE",
            4,
        ))
        catalog_ids = [
            spec.element_id
            for spec in sorted(catalog.values(), key=lambda item: (item.category, item.element_id))
        ]
        selected: list[str] = []
        for element_id in (*added_ids, *shortlist):
            if element_id in catalog and element_id not in selected:
                selected.append(element_id)
            if len(selected) >= max_ids:
                return selected
        if catalog_ids:
            offset = epoch % len(catalog_ids)
            rotated = catalog_ids[offset:] + catalog_ids[:offset]
        else:
            rotated = []
        for element_id in rotated:
            if element_id in catalog and element_id not in selected:
                selected.append(element_id)
            if len(selected) >= max_ids:
                return selected
        for element_id in current_inner_ids:
            if element_id in catalog and element_id not in selected:
                selected.append(element_id)
            if len(selected) >= max_ids:
                return selected
        return selected

    def apply_plan(
        self,
        *,
        epoch: int,
        shortlist: Iterable[str],
        plan: dict[str, Any],
        failed_history_epochs: Iterable[int] = (),
        failed_outer_library_epochs: Iterable[int] = (),
        imperfect_score_epochs: Iterable[int] = (),
        current_inner_element_ids: Iterable[str] = (),
        non_adopted_element_ids: Iterable[str] = (),
    ) -> OuterLibraryUpdate:
        catalog = self.catalog()
        plan = _normalize_outer_plan(plan)
        revision_before = self.revision()
        current_inner_ids = tuple(dict.fromkeys(
            str(item) for item in current_inner_element_ids
        ))
        non_adopted_ids = frozenset(
            str(item) for item in non_adopted_element_ids
        )
        unknown_non_adopted = sorted(non_adopted_ids - set(catalog))
        if unknown_non_adopted:
            raise ValueError(
                "non-adoption evidence contains unknown element ids: "
                f"{unknown_non_adopted}"
            )
        unknown_current = sorted(set(current_inner_ids) - set(catalog))
        if unknown_current:
            raise ValueError(
                f"current inner proposal selection contains unknown ids: {unknown_current}"
            )
        shortlisted = tuple(dict.fromkeys(str(item) for item in shortlist))
        unknown_shortlist = sorted(set(shortlisted) - set(catalog))
        if unknown_shortlist:
            raise ValueError(f"outer shortlist contains unknown ids: {unknown_shortlist}")

        raw_decisions = plan.get("operations", [])
        if not isinstance(raw_decisions, list) or not all(
            isinstance(item, dict) for item in raw_decisions
        ):
            raise ValueError("outer plan operations must be an object list")
        decisions: dict[str, dict[str, Any]] = {}
        for item in raw_decisions:
            element_id = str(item.get("element_id", ""))
            if element_id in decisions:
                raise ValueError(f"duplicate outer operation for {element_id}")
            decisions[element_id] = dict(item)
        unknown = sorted(set(decisions) - set(catalog))
        if unknown:
            raise ValueError(f"outer plan contains unknown elements: {unknown}")
        for element_id in sorted(set(catalog) - set(decisions)):
            decisions[element_id] = {
                "element_id": element_id,
                "operation": "unchanged",
                "reason": "implicit unchanged: omitted from the sparse outer plan",
            }
        for element_id, decision in decisions.items():
            operation = str(decision.get("operation", "")).casefold()
            if operation not in OUTER_LIBRARY_OPERATIONS - {"add"}:
                raise ValueError(f"invalid operation {operation!r} for {element_id}")
            if element_id not in shortlisted and operation != "unchanged":
                raise ValueError(
                    f"undisclosed element {element_id} may only remain unchanged"
                )

        metadata = self.metadata()
        next_catalog = dict(catalog)
        processed_merges: set[frozenset[str]] = set()
        merged_sources: dict[str, tuple[HarnessElementConfig, HarnessElementConfig]] = {}
        for element_id, decision in decisions.items():
            operation = str(decision["operation"]).casefold()
            if operation == "unchanged":
                continue
            if operation == "delete":
                self._validate_delete(
                    element_id=element_id,
                    decision=decision,
                    metadata=metadata,
                )
                next_catalog.pop(element_id)
                continue
            if operation == "modify":
                replacement = HarnessElementConfig.from_dict(
                    dict(decision.get("replacement", {}))
                )
                current = catalog[element_id]
                if replacement.element_id != element_id or replacement.category != current.category:
                    raise ValueError("modify must preserve element id and category")
                self._validate_modify(
                    element_id=element_id,
                    decision=decision,
                    replacement=replacement,
                    current=current,
                    metadata=metadata,
                    non_adoption_repair=element_id in non_adopted_ids,
                )
                next_catalog[element_id] = replacement
                continue
            if operation == "merge":
                other_id = str(decision.get("merge_with", ""))
                if other_id not in catalog or other_id == element_id:
                    raise ValueError(f"invalid merge partner for {element_id}: {other_id}")
                if other_id not in shortlisted:
                    raise ValueError("both merge elements must be progressively disclosed")
                partner = decisions[other_id]
                if (
                    str(partner.get("operation", "")).casefold() != "merge"
                    or str(partner.get("merge_with", "")) != element_id
                ):
                    raise ValueError("merge decisions must be symmetric")
                if partner.get("merged_element") != decision.get("merged_element"):
                    raise ValueError("symmetric merge decisions must use the same merged element")
                pair = frozenset({element_id, other_id})
                if pair in processed_merges:
                    continue
                left = catalog[element_id]
                right = catalog[other_id]
                similarity_threshold = 0.40 if _outer_dynamics_mode() else 0.55
                content_threshold = 0.35 if _outer_dynamics_mode() else 0.50
                if (
                    element_similarity(left, right) < similarity_threshold
                    or _element_content_similarity(left, right) < content_threshold
                ):
                    raise ValueError("merge requires similar same-category elements")
                merged = HarnessElementConfig.from_dict(
                    dict(decision.get("merged_element", {}))
                )
                _validate_non_coercive_delegation(merged)
                if merged.category != left.category or merged.category != right.category:
                    raise ValueError("merged element must preserve the source category")
                if merged.element_id in catalog and merged.element_id not in pair:
                    raise ValueError("merged element id collides with an existing element")
                next_catalog.pop(element_id)
                next_catalog.pop(other_id)
                next_catalog[merged.element_id] = merged
                merged_sources[merged.element_id] = (left, right)
                processed_merges.add(pair)

        additions = plan.get("additions", [])
        if not isinstance(additions, list) or not all(isinstance(item, dict) for item in additions):
            raise ValueError("outer plan additions must be an object list")
        if len(additions) > 2:
            raise ValueError("outer plan may add at most 2 boundary elements per epoch")
        available_epochs = {int(item) for item in failed_history_epochs}
        available_epochs.update(int(item) for item in failed_outer_library_epochs)
        available_epochs.update(int(item) for item in imperfect_score_epochs)
        added_ids: list[str] = []
        applied_additions: list[dict[str, Any]] = []
        for addition in additions:
            if str(addition.get("operation", "add")).casefold() != "add":
                raise ValueError("outer addition must use operation=add")
            if not str(addition.get("capability_boundary_evidence", "")).strip():
                raise ValueError("add requires capability-boundary evidence")
            supporting_epochs = addition.get("supporting_epoch_ids", [])
            if not isinstance(supporting_epochs, list):
                raise ValueError(
                    "add requires supporting failed or imperfect-score epoch ids"
                )
            if not supporting_epochs and not _outer_dynamics_mode():
                raise ValueError(
                    "add requires supporting failed or imperfect-score epoch ids"
                )
            if supporting_epochs and not all(
                isinstance(item, int) and item in available_epochs
                for item in supporting_epochs
            ):
                raise ValueError(
                    "add requires supporting failed or imperfect-score epoch ids"
                )
            spec = HarnessElementConfig.from_dict(dict(addition.get("element", {})))
            _validate_non_coercive_delegation(spec)
            addition_evidence = str(
                addition.get("capability_boundary_evidence", "")
            ).casefold()
            for non_adopted_id in non_adopted_ids:
                existing = next_catalog.get(non_adopted_id)
                if existing is None or spec.category != existing.category:
                    continue
                evidence_names_existing = non_adopted_id.casefold() in addition_evidence
                overlapping_replacement = (
                    element_similarity(spec, existing) >= 0.75
                    and _element_content_similarity(spec, existing) >= 0.50
                )
                if evidence_names_existing or overlapping_replacement:
                    raise ValueError(
                        "addition duplicates a formally non-adopted existing element; "
                        f"repair it with modify instead: {non_adopted_id}"
                    )
            if spec.category not in ELEMENT_CATEGORIES:
                raise ValueError(f"invalid added element category {spec.category}")
            if spec.element_id in next_catalog:
                if spec == next_catalog[spec.element_id]:
                    # Re-adding an active element is idempotent. Re-adding an exact
                    # dormant catalog element is an evidence-backed activation and
                    # must enter the next progressive selection to escape cold start.
                    if spec.element_id not in current_inner_ids:
                        if spec.element_id not in added_ids:
                            added_ids.append(spec.element_id)
                        activation = dict(addition)
                        activation["activation_only"] = True
                        applied_additions.append(activation)
                    continue
                if _outer_dynamics_mode():
                    if spec.element_id not in added_ids:
                        added_ids.append(spec.element_id)
                    applied_additions.append(addition)
                    continue
                raise ValueError(f"added element id already exists: {spec.element_id}")
            for existing in next_catalog.values():
                if (
                    element_similarity(spec, existing) >= 0.75
                    and _element_content_similarity(spec, existing) >= 0.65
                ):
                    raise ValueError(
                        "add duplicates an existing capability instead of extending the boundary: "
                        f"{spec.element_id} ~ {existing.element_id}"
                    )
            next_catalog[spec.element_id] = spec
            added_ids.append(spec.element_id)
            applied_additions.append(addition)

        next_inner_ids: list[str] = []
        for element_id in current_inner_ids:
            decision = decisions[element_id]
            operation = str(decision["operation"]).casefold()
            if operation == "delete":
                continue
            if operation == "merge":
                merged_id = str(dict(decision.get("merged_element", {})).get("id", ""))
                if merged_id in next_catalog and merged_id not in next_inner_ids:
                    next_inner_ids.append(merged_id)
                continue
            if element_id in next_catalog and element_id not in next_inner_ids:
                next_inner_ids.append(element_id)
        for element_id in added_ids:
            if element_id not in next_inner_ids:
                next_inner_ids.append(element_id)
        if not next_inner_ids and next_catalog:
            ranked = sorted(
                next_catalog,
                key=lambda element_id: (
                    -int(metadata.get(element_id, {}).get("usage_count", 0)),
                    -float(metadata.get(element_id, {}).get("score_mean") or 0.0),
                    element_id,
                ),
            )
            next_inner_ids.append(ranked[0])
        if _outer_dynamics_mode():
            next_inner_ids = self._dynamics_next_inner_ids(
                epoch=epoch,
                shortlist=shortlisted,
                current_inner_ids=tuple(next_inner_ids),
                catalog=next_catalog,
                added_ids=added_ids,
            )

        changed = {
            element_id: decision
            for element_id, decision in decisions.items()
            if str(decision["operation"]).casefold() != "unchanged"
        }
        revision_after = revision_before + (1 if changed or applied_additions else 0)
        if revision_after == revision_before:
            return OuterLibraryUpdate(
                epoch=epoch,
                status="unchanged",
                revision_before=revision_before,
                revision_after=revision_after,
                shortlist=shortlisted,
                operations=tuple(
                    decisions[element_id] for element_id in sorted(decisions)
                ),
                additions=(),
                next_inner_element_ids=tuple(next_inner_ids),
            )
        raw = read_json(self.catalog_path)
        next_catalog_payload = {
            **raw,
            "revision": revision_after,
            "items": [
                _element_payload(item)
                for item in sorted(
                    next_catalog.values(),
                    key=lambda value: (value.category, value.element_id),
                )
            ],
            "updated_at": utc_now(),
        }
        stats = HarnessElementStatsStore.load(self.stats_path)
        for merged_id, (left, right) in merged_sources.items():
            left_stat = stats.items.get(
                element_stat_key(left.category, left.element_id),
                ElementStat(left.element_id, left.category),
            )
            right_stat = stats.items.get(
                element_stat_key(right.category, right.element_id),
                ElementStat(right.element_id, right.category),
            )
            stats.items[element_stat_key(left.category, merged_id)] = ElementStat(
                element_id=merged_id,
                category=left.category,
                usage_count=left_stat.usage_count + right_stat.usage_count,
                success_count=left_stat.success_count + right_stat.success_count,
                score_count=left_stat.score_count + right_stat.score_count,
                score_total=left_stat.score_total + right_stat.score_total,
                score_sum_squares=(
                    left_stat.score_sum_squares + right_stat.score_sum_squares
                ),
                hard_regression_ever=(
                    left_stat.hard_regression_ever or right_stat.hard_regression_ever
                ),
                hard_regression_count=(
                    left_stat.hard_regression_count + right_stat.hard_regression_count
                ),
                attributed_inner_epochs=sorted(set(
                    left_stat.attributed_inner_epochs
                    + right_stat.attributed_inner_epochs
                )),
            )
        for spec in next_catalog.values():
            key = element_stat_key(spec.category, spec.element_id)
            stats.items.setdefault(key, ElementStat(spec.element_id, spec.category))
        stats.updated_at = utc_now()
        next_stats_payload = {
            "schema_version": "harness-element-stats.v2",
            "updated_at": stats.updated_at,
            "items": {
                key: item.to_dict() for key, item in stats.items.items()
            },
        }
        before_stats = read_json(self.stats_path)
        transaction = {
            "schema_version": "outer-library-transaction.v1",
            "epoch": epoch,
            "before_catalog": raw,
            "before_stats": before_stats,
            "created_at": utc_now(),
        }
        atomic_write_json(self.transaction_path, transaction)
        transaction_resolved = False
        try:
            atomic_write_json(self.stats_path, next_stats_payload)
            atomic_write_json(self.catalog_path, next_catalog_payload)
            transaction_resolved = True
        except Exception:
            atomic_write_json(self.stats_path, before_stats)
            atomic_write_json(self.catalog_path, raw)
            transaction_resolved = True
            raise
        finally:
            if transaction_resolved:
                self.transaction_path.unlink(missing_ok=True)
        return OuterLibraryUpdate(
            epoch=epoch,
            status="applied" if revision_after != revision_before else "unchanged",
            revision_before=revision_before,
            revision_after=revision_after,
            shortlist=shortlisted,
            operations=tuple(decisions[element_id] for element_id in sorted(decisions)),
            additions=tuple(dict(item) for item in applied_additions),
            next_inner_element_ids=tuple(next_inner_ids),
        )

    def write_epoch_record(self, epoch: int, payload: dict[str, Any]) -> None:
        self.epochs_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.epochs_dir / f"epoch_{epoch:03d}.json", payload)


class OuterHarnessLibraryAgent:
    """Progressively disclose and evolve the outer loop's own element library."""

    def __init__(
        self,
        store: OuterHarnessLibraryStore,
        request_json: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
        *,
        max_structural_actions: int = 1,
        max_additions: int = 1,
    ):
        if max_structural_actions < 1:
            raise ValueError("max_structural_actions must be positive")
        if not 0 <= max_additions <= max_structural_actions:
            raise ValueError("max_additions must be within the structural action limit")
        self.store = store
        self.request_json = request_json or self._request_with_configured_backbone
        self.max_structural_actions = max_structural_actions
        self.max_additions = max_additions

    def _operation_eligibility(
        self,
        element_ids: Iterable[str],
        *,
        non_adopted_element_ids: Iterable[str] = (),
    ) -> dict[str, dict[str, Any]]:
        catalog = self.store.catalog()
        metadata = self.store.metadata()
        requested = tuple(dict.fromkeys(str(item) for item in element_ids))
        non_adopted = frozenset(str(item) for item in non_adopted_element_ids)
        result: dict[str, dict[str, Any]] = {}
        for element_id in requested:
            stat = metadata[element_id]
            usage_count = int(stat.get("usage_count", 0))
            contract_repair = not _subagent_persona_contract_valid(catalog[element_id])
            non_adoption_repair = (
                catalog[element_id].category == "subagent"
                and element_id in non_adopted
            )
            if _outer_dynamics_mode():
                modify_min = _outer_dynamics_int(
                    "GAME_LOOP_OUTER_LIBRARY_DYNAMICS_MODIFY_MIN_USAGE", 0
                )
                modify_allowed = (
                    contract_repair or non_adoption_repair or usage_count >= modify_min
                )
                delete_allowed = usage_count == 0 or (
                    usage_count >= 5 and self.store._is_low_score(element_id, metadata)
                )
            else:
                modify_allowed = contract_repair or non_adoption_repair or (
                    usage_count >= 3
                    and (
                        self.store._is_low_score(element_id, metadata)
                        or stat.get("hard_regression_ever") is True
                    )
                )
                delete_allowed = usage_count >= 5 and self.store._is_low_score(
                    element_id, metadata
                )
            merge_partners = [
                other_id
                for other_id in requested
                if other_id != element_id
                and catalog[other_id].category == catalog[element_id].category
                and element_similarity(catalog[element_id], catalog[other_id])
                >= (0.40 if _outer_dynamics_mode() else 0.55)
                and _element_content_similarity(catalog[element_id], catalog[other_id])
                >= (0.35 if _outer_dynamics_mode() else 0.50)
            ]
            result[element_id] = {
                "usage_count": usage_count,
                "contract_repair": contract_repair,
                "non_adoption_repair": non_adoption_repair,
                "unchanged": True,
                "modify": modify_allowed,
                "delete": delete_allowed,
                "merge_with": merge_partners,
            }
        return result

    def _validate_plan_throughput(
        self,
        plan: dict[str, Any],
        *,
        non_adopted_element_ids: Iterable[str] = (),
    ) -> dict[str, Any]:
        normalized = _normalize_outer_plan(plan)
        non_adopted_ids = frozenset(
            str(item) for item in non_adopted_element_ids
        )
        additions = normalized.get("additions", [])
        if not isinstance(additions, list):
            raise ValueError("outer plan additions must be a list")
        if len(additions) > self.max_additions:
            raise ValueError(
                f"outer plan additions {len(additions)} exceed configured limit "
                f"{self.max_additions}"
            )
        operations = normalized.get("operations", [])
        if not isinstance(operations, list):
            raise ValueError("outer plan operations must be a list")
        merge_pairs: set[frozenset[str]] = set()
        ordinary_actions = 0
        for operation in operations:
            if not isinstance(operation, dict):
                continue
            kind = str(operation.get("operation", "unchanged")).casefold()
            if kind == "unchanged":
                continue
            if kind == "merge":
                merge_pairs.add(
                    frozenset(
                        {
                            str(operation.get("element_id", "")),
                            str(operation.get("merge_with", "")),
                        }
                    )
                )
            else:
                ordinary_actions += 1
        action_count = ordinary_actions + len(merge_pairs) + len(additions)
        if action_count > self.max_structural_actions:
            raise ValueError(
                f"outer plan structural actions {action_count} exceed configured "
                f"limit {self.max_structural_actions}"
            )
        for operation in operations:
            if not isinstance(operation, dict):
                continue
            kind = str(operation.get("operation", "")).casefold()
            if kind == "merge":
                element_id = str(operation.get("element_id", "")).strip()
                merge_with = str(operation.get("merge_with", "")).strip()
                if not element_id or not merge_with or merge_with == element_id:
                    raise ValueError(
                        f"merge requires a distinct non-empty partner: {element_id}"
                    )
                merged_element = operation.get("merged_element")
                if not isinstance(merged_element, dict) or not merged_element:
                    raise ValueError(
                        f"merge requires a complete merged_element: {element_id}"
                    )
                merged = HarnessElementConfig.from_dict(merged_element)
                _validate_evolved_subagent_persona(merged)
            if kind == "modify" and not str(
                operation.get("correction_hypothesis", "")
            ).strip():
                element_id = str(operation.get("element_id", ""))
                raise ValueError(
                    f"modify requires a correction hypothesis: {element_id}"
                )
            if kind == "modify":
                replacement = operation.get("replacement")
                if not isinstance(replacement, dict) or not replacement:
                    raise ValueError(
                        "modify requires a complete replacement element: "
                        f"{operation.get('element_id', '')}"
                    )
                replacement_element = HarnessElementConfig.from_dict(replacement)
                _validate_evolved_subagent_persona(replacement_element)
        for addition in additions:
            if not isinstance(addition, dict):
                continue
            raw_element = addition.get("element")
            if not isinstance(raw_element, dict) or not raw_element:
                continue
            added_element = HarnessElementConfig.from_dict(raw_element)
            _validate_evolved_subagent_persona(added_element)
        if not self.store.catalog_path.is_file():
            return normalized
        catalog = self.store.catalog()
        metadata = self.store.metadata()
        merge_operations = {
            str(operation.get("element_id", "")): operation
            for operation in operations
            if isinstance(operation, dict)
            and str(operation.get("operation", "")).casefold() == "merge"
        }
        for element_id, operation in merge_operations.items():
            merge_with = str(operation.get("merge_with", ""))
            if element_id not in catalog or merge_with not in catalog:
                raise ValueError(
                    f"merge elements must already exist: {element_id}, {merge_with}"
                )
            partner = merge_operations.get(merge_with)
            if (
                partner is None
                or str(partner.get("merge_with", "")) != element_id
                or partner.get("merged_element") != operation.get("merged_element")
            ):
                raise ValueError(
                    f"merge decisions must be symmetric: {element_id}, {merge_with}"
                )
            left = catalog[element_id]
            right = catalog[merge_with]
            similarity_threshold = 0.40 if _outer_dynamics_mode() else 0.55
            content_threshold = 0.35 if _outer_dynamics_mode() else 0.50
            if (
                element_similarity(left, right) < similarity_threshold
                or _element_content_similarity(left, right) < content_threshold
            ):
                raise ValueError("merge requires similar same-category elements")
        for operation in operations:
            if not isinstance(operation, dict):
                continue
            kind = str(operation.get("operation", "")).casefold()
            element_id = str(operation.get("element_id", ""))
            if kind == "delete" and element_id in catalog:
                self.store._validate_delete(
                    element_id=element_id,
                    decision=operation,
                    metadata=metadata,
                )
                continue
            if kind != "modify":
                continue
            if element_id not in catalog:
                continue
            replacement = HarnessElementConfig.from_dict(
                dict(operation["replacement"])
            )
            self.store._validate_modify(
                element_id=element_id,
                decision=operation,
                replacement=replacement,
                current=catalog[element_id],
                metadata=metadata,
                non_adoption_repair=element_id in non_adopted_ids,
            )
        return normalized

    @staticmethod
    def _validate_plan_evidence(
        plan: dict[str, Any],
        *,
        available_epochs: set[int],
    ) -> None:
        additions = plan.get("additions", [])
        if not isinstance(additions, list):
            raise ValueError("outer plan additions must be a list")
        for addition in additions:
            if not isinstance(addition, dict):
                raise ValueError("outer plan additions must be objects")
            supporting = addition.get("supporting_epoch_ids", [])
            if not isinstance(supporting, list):
                raise ValueError("add requires supporting_epoch_ids list")
            if not supporting and not _outer_dynamics_mode():
                raise ValueError(
                    "add requires supporting failed or imperfect-score epoch ids"
                )
            if not all(
                isinstance(item, int) and item in available_epochs
                for item in supporting
            ):
                raise ValueError(
                    "add cites unavailable supporting failed or imperfect-score epoch ids"
                )
            HarnessElementConfig.from_dict(dict(addition.get("element", {})))

    def _fallback_non_adoption_repair_plan(
        self,
        *,
        shortlist: tuple[str, ...],
        required_ids: tuple[str, ...],
    ) -> dict[str, Any] | None:
        """Make one evidence-scoped repair when the model repeats an identical plan."""

        if not required_ids or not set(required_ids).issubset(shortlist):
            return None
        catalog = self.store.catalog()
        operations: list[dict[str, Any]] = []
        for element_id in required_ids:
            current = catalog.get(element_id)
            if current is None or current.category != "subagent":
                return None
            replacement = _element_payload(current)
            persona = str(replacement["spec"].get("persona", "")).rstrip()
            marker = (
                " Observable delegation evidence is limited to a bounded artifact slice, "
                "independent local checks, and a concrete handoff; it does not require a "
                "fork call or presume a fixed role or topology."
            )
            if marker.strip() in persona:
                return None
            replacement["spec"]["persona"] = persona + marker
            operations.append({
                "element_id": element_id,
                "operation": "modify",
                "reason": (
                    "Formal zero-invocation evidence requires a concrete observable trigger "
                    "repair on the existing prototype."
                ),
                "correction_hypothesis": (
                    "Making delegation evidence observable and bounded may improve child-job "
                    "selection without requiring invocation."
                ),
                "replacement": replacement,
            })
        return {"operations": operations, "additions": []}

    @staticmethod
    def _request_with_configured_backbone(
        stage: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        from game_loop.chat_agent import LocalChatAgent

        system = (
            "You evolve an outer-loop harness element library. Return one JSON object only. "
            "Use evidence conservatively and never invent benchmark-private information."
        )
        agent = LocalChatAgent()
        request = json.dumps({"stage": stage, **payload}, ensure_ascii=False)
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": request},
        ]
        last_error: Exception | None = None
        for attempt in range(4):
            response = agent._call_api(messages)
            message = response["choices"][0]["message"]
            content = message.get("content") or message.get("reasoning_content") or ""
            try:
                return _extract_json_object(str(content))
            except (TypeError, ValueError, SyntaxError) as exc:
                last_error = exc
                if attempt == 3:
                    break
                messages = [
                    *messages,
                    {"role": "assistant", "content": str(content)[:12000]},
                    {
                        "role": "user",
                        "content": (
                            "Your previous response could not be parsed as the required inert "
                            f"JSON object ({type(exc).__name__}: {exc}). Return only one valid "
                            "JSON object matching the requested schema. Do not include prose, "
                            "markdown fences, Python literals, commentary, or placeholder values. "
                            "Every operations/additions item must be fully populated; use an empty "
                            "JSON array when there are no items, never [...]."
                        ),
                    },
                ]
        assert last_error is not None
        raise last_error

    def evolve(
        self,
        *,
        epoch: int,
        inner_history: list[dict[str, Any]],
        latest_inner_result: HarnessEpochResult,
        current_inner_element_ids: Iterable[str] = (),
        non_adopted_element_ids: Iterable[str] = (),
        required_non_adoption_repair_ids: Iterable[str] = (),
        prototype_evidence: Iterable[Mapping[str, Any]] = (),
    ) -> OuterLibraryUpdate:
        current_inner_ids = tuple(dict.fromkeys(
            str(item) for item in current_inner_element_ids
        ))
        non_adopted_ids = tuple(dict.fromkeys(
            str(item) for item in non_adopted_element_ids
        ))
        required_non_adoption_repairs = tuple(dict.fromkeys(
            str(item) for item in required_non_adoption_repair_ids
        ))
        prototype_evidence_rows = [
            dict(item) for item in prototype_evidence if isinstance(item, Mapping)
        ]
        if not set(required_non_adoption_repairs).issubset(non_adopted_ids):
            raise ValueError(
                "required non-adoption repairs must have formal non-adoption evidence"
            )
        revision = self.store.revision()
        record: dict[str, Any] = {
            "schema_version": "outer-library-evolution.v1",
            "epoch": epoch,
            "status": "shortlisting",
            "disclosure_policy": self.store.disclosure_policy,
            "revision_before": revision,
            "catalog_index": self.store.progressive_index(),
            "shortlist": [],
            "disclosed_elements": [],
            "plan": None,
            "current_inner_element_ids": list(current_inner_ids),
            "non_adopted_element_ids": list(non_adopted_ids),
            "required_non_adoption_repair_ids": list(
                required_non_adoption_repairs
            ),
            "prototype_evidence": prototype_evidence_rows,
            "created_at": utc_now(),
        }
        self.store.write_epoch_record(epoch, record)
        try:
            catalog_ids = {str(item["id"]) for item in record["catalog_index"]}
            unknown_required_repairs = sorted(
                set(required_non_adoption_repairs) - catalog_ids
            )
            if unknown_required_repairs:
                raise ValueError(
                    "required non-adoption repair contains unknown element ids: "
                    f"{unknown_required_repairs}"
                )
            if _outer_dynamics_mode():
                shortlist_limit = min(
                    len(catalog_ids),
                    max(1, _outer_dynamics_int(
                        "GAME_LOOP_OUTER_LIBRARY_DYNAMICS_SHORTLIST_LIMIT",
                        6,
                    )),
                )
            else:
                shortlist_limit = min(
                    len(catalog_ids),
                    max(1, min(8, (len(catalog_ids) + 2) // 3)),
                )
            shortlist_task = (
                f"Select at most {shortlist_limit} existing objects that the evidence makes "
                "worth inspecting. Return {shortlist:[ids], addition_needed:boolean, "
                "rationale:string}. You have index metadata only, so do not infer hidden "
                "details. A valid rubric score below 1.0 may justify addition_needed=true."
            )
            if required_non_adoption_repairs:
                shortlist_task += (
                    " Include every id in required_non_adoption_repair_ids because each has "
                    "a concrete audited mismatch that requires progressive disclosure."
                )
            if _outer_dynamics_mode():
                shortlist_task += (
                    " Dynamics-study mode is active: prefer a diverse shortlist that exposes "
                    "contrasting outer_exposure patterns, including repeatedly disclosed unchanged "
                    "elements, inactive/dormant elements, and active high-use elements."
                )
            shortlist_payload = {
                    "catalog_index": record["catalog_index"],
                    "shortlist_limit": shortlist_limit,
                    "inner_history": _compact_outer_inner_history(inner_history[-20:]),
                    "latest_inner_result": _compact_inner_epoch_result(
                        latest_inner_result
                    ),
                    "current_inner_element_ids": list(current_inner_ids),
                    "task": shortlist_task,
            }
            shortlist_response: dict[str, Any] = {}
            shortlist_raw: list[Any] = []
            for semantic_attempt in range(4):
                shortlist_response = self.request_json("shortlist", shortlist_payload)
                try:
                    raw_value = shortlist_response.get("shortlist", [])
                    if not isinstance(raw_value, list):
                        raise TypeError("outer shortlist must be a list")
                    unknown_shortlist = sorted(
                        {str(item) for item in raw_value} - catalog_ids
                    )
                    if unknown_shortlist:
                        raise ValueError(
                            f"outer shortlist returned unknown ids: {unknown_shortlist}"
                        )
                    if len(raw_value) > shortlist_limit:
                        raise ValueError(
                            "outer shortlist exceeds progressive disclosure limit "
                            f"{shortlist_limit}: {len(raw_value)}"
                        )
                    missing_required = sorted(
                        set(required_non_adoption_repairs)
                        - {str(item) for item in raw_value}
                    )
                    if missing_required:
                        raise ValueError(
                            "outer shortlist omitted required non-adoption repairs: "
                            f"{missing_required}"
                        )
                    shortlist_raw = raw_value
                    break
                except (TypeError, ValueError) as exc:
                    if semantic_attempt == 3:
                        raise
                    shortlist_payload = {
                        **shortlist_payload,
                        "previous_invalid_response": shortlist_response,
                        "validation_error": f"{type(exc).__name__}: {exc}",
                        "task": (
                            shortlist_task
                            + " Correct the previous response using only exact ids from "
                            "catalog_index; do not emit schema placeholders such as 'ids'."
                        ),
                    }
            shortlist = tuple(
                dict.fromkeys(str(item) for item in shortlist_raw)
            )
            record.update(
                status="planning",
                shortlist=list(shortlist),
                disclosed_elements=self.store.details(shortlist),
                shortlist_response=shortlist_response,
            )
            self.store.write_epoch_record(epoch, record)
            plan_task = (
                "Use evolution_contract to make the smallest coherent evidence-backed library "
                "change. Omit disclosed objects that should stay unchanged. Change only "
                "disclosed existing objects. For modify, preserve id/category and provide "
                "correction_hypothesis plus a complete replacement. For merge, emit symmetric "
                "decisions with the same merged_element. Delete only when modification cannot "
                "repair the object and include modification_inadequate_reason. Put new objects "
                "in additions with capability_boundary_evidence and supporting_epoch_ids. "
                "Schema: {operations:[{element_id,operation,reason,...}], additions:[...]}. "
                f"Use at most {self.max_structural_actions} structural actions and "
                f"{self.max_additions} additions. For category=subagent, write one bounded child "
                "job in persona using the exact labels Use when:, Scope:, Deliverable:, "
                "Done when:, and Return:. Make the capability reusable across tasks; do not "
                "name a benchmark, product, game, task instance, source file, fixed team role, "
                "or topology. The system handles fork automatically."
            )
            if _outer_dynamics_mode():
                plan_task = (
                    "Dynamics-study mode is active. Use evolution_contract and produce sparse "
                    "non-keep actions when the "
                    "evidence shows useful library differentiation; do not emit operations for "
                    "elements that should merely stay unchanged. You may delete dormant elements "
                    "that have been repeatedly shortlisted/disclosed yet remain unused when you "
                    "explain why modification is inadequate. You may modify an unused or active "
                    "element when the replacement preserves id/category and gives a concrete "
                    "correction_hypothesis. You may merge moderately similar disclosed elements "
                    "with symmetric merge decisions. You may add a distinct exploratory boundary "
                    "element from repeated no-op, shortlist, or outer-library failure patterns; "
                    "supporting_epoch_ids may be empty only when the evidence is repeated "
                    "outer_exposure rather than a failed epoch. Prefer a coherent evidence-backed "
                    f"transaction of at most {self.max_structural_actions} structural actions "
                    f"and at most {self.max_additions} additions. Schema: "
                    "{operations:[{element_id,operation,reason,...}], additions:[...]}. "
                    "Every modify must include correction_hypothesis and a complete replacement "
                    "object with id, category, description, spec, and tags. "
                    "For zero-use deletion include unused_or_dormant_evidence and "
                    "modification_inadequate_reason."
                )
            element_metadata = self.store.metadata()
            operation_eligibility = self._operation_eligibility(
                shortlist,
                non_adopted_element_ids=non_adopted_ids,
            )
            plan_payload = {
                    "all_element_ids": sorted(catalog_ids),
                    "shortlist": list(shortlist),
                    "disclosed_elements": record["disclosed_elements"],
                    "element_metadata": {
                        element_id: element_metadata[element_id]
                        for element_id in shortlist
                    },
                    "element_operation_eligibility": operation_eligibility,
                    "inner_history": _compact_outer_inner_history(inner_history[-20:]),
                    "latest_inner_result": _compact_inner_epoch_result(
                        latest_inner_result
                    ),
                    "current_inner_element_ids": list(current_inner_ids),
                    "non_adopted_element_ids": list(non_adopted_ids),
                    "required_non_adoption_repair_ids": list(
                        required_non_adoption_repairs
                    ),
                    "prototype_evidence": prototype_evidence_rows,
                    "operations": ["add", "delete", "modify", "merge"],
                    "evolution_contract": _simple_evolution_contract(),
                    "task": plan_task,
            }
            plan_payload["task"] += (
                " element_operation_eligibility is authoritative. Never emit modify or "
                "delete when its value is false, and only merge with a listed partner. "
                "When non_adopted_element_ids names an existing prototype, repair that "
                "object with modify instead of adding a sibling replacement. "
                "Every id in required_non_adoption_repair_ids has a concrete audited "
                "contract mismatch and must receive one modify operation in this plan. "
                "When all existing-object structural actions are ineligible, use additions "
                "for a genuinely distinct evidence-backed object or return empty arrays."
            )
            (
                failed_history_epochs,
                failed_outer_library_epochs,
                imperfect_score_epochs,
            ) = _evidence_epoch_sets(
                latest_inner_result=latest_inner_result,
                inner_history=inner_history,
            )
            available_evidence_epochs = {
                *failed_history_epochs,
                *failed_outer_library_epochs,
                *imperfect_score_epochs,
            }
            plan: dict[str, Any] = {}
            for semantic_attempt in range(4):
                plan = self.request_json("plan", plan_payload)
                try:
                    plan = self._validate_plan_throughput(
                        plan,
                        non_adopted_element_ids=non_adopted_ids,
                    )
                    operations_by_id = {
                        str(item.get("element_id", "")): str(
                            item.get("operation", "")
                        ).casefold()
                        for item in plan.get("operations", [])
                        if isinstance(item, dict)
                    }
                    missing_repairs = [
                        element_id
                        for element_id in required_non_adoption_repairs
                        if operations_by_id.get(element_id) != "modify"
                    ]
                    if missing_repairs:
                        raise ValueError(
                            "formal non-adoption diagnostics require modify operations for: "
                            + ", ".join(missing_repairs)
                        )
                    self._validate_plan_evidence(
                        plan,
                        available_epochs=available_evidence_epochs,
                    )
                    break
                except (TypeError, ValueError) as exc:
                    record.update(status="planning", plan=plan)
                    self.store.write_epoch_record(epoch, record)
                    if semantic_attempt == 3:
                        fallback_plan = self._fallback_non_adoption_repair_plan(
                            shortlist=shortlist,
                            required_ids=required_non_adoption_repairs,
                        )
                        if (
                            fallback_plan is None
                            and not required_non_adoption_repairs
                            and any(item in non_adopted_ids for item in shortlist)
                        ):
                            fallback_plan = {"operations": [], "additions": []}
                        if fallback_plan is None:
                            raise
                        # Keep the normal validators as the final authority. This
                        # fallback only prevents a repeated no-op model response
                        # from deadlocking an evidence-backed repair.
                        plan = self._validate_plan_throughput(
                            fallback_plan,
                            non_adopted_element_ids=non_adopted_ids,
                        )
                        self._validate_plan_evidence(
                            plan,
                            available_epochs=available_evidence_epochs,
                        )
                        break
                    plan_payload = {
                        **plan_payload,
                        "previous_invalid_response": plan,
                        "validation_error": f"{type(exc).__name__}: {exc}",
                        "task": (
                            plan_task
                            + " Correct the previous response to satisfy the exact schema, "
                            "action limits, and disclosed-element constraints. For modify, copy "
                            "the disclosed element into replacement and concretely change its "
                            "description/spec; include id, category, description, spec, tags, "
                            "and correction_hypothesis."
                            " Obey element_operation_eligibility exactly. If the validation "
                            "error says an operation lacks enough uses or evidence, remove that "
                            "operation; add a distinct boundary object instead only when the "
                            "available evidence supports it. For every category=subagent result, "
                            "put the exact labels Use when:, Scope:, Deliverable:, Done when:, "
                            "and Return: inside its single persona string and keep it reusable "
                            "rather than task-, game-, file-, role-, or topology-specific. "
                            "If the validation error says 'modify replacement must change the "
                            "element', do not copy the disclosed element: make a concrete "
                            "behavior-level change to its description or persona/spec while "
                            "preserving id and category. For a formally uninvoked child, make "
                            "the Use when clause observable and bounded (for example, an "
                            "independent artifact boundary plus local checks), and never add "
                            "an invocation quota or require a fork call."
                        ),
                    }
            record.update(status="applying", plan=plan)
            audit_record_error: str | None = None
            try:
                self.store.write_epoch_record(epoch, record)
            except Exception as exc:  # noqa: BLE001 - keep the valid plan actionable.
                audit_record_error = f"audit_record_error: {type(exc).__name__}: {exc}"
            failed_history_epochs: set[int] = set()
            failed_outer_library_epochs: set[int] = set()
            imperfect_score_epochs: set[int] = set()
            if not latest_inner_result.accepted:
                failed_history_epochs.add(latest_inner_result.epoch)
            latest_rubric = latest_inner_result.rubric_validation
            if (
                isinstance(latest_rubric, dict)
                and latest_rubric.get("infrastructure_ok") is True
                and _compact_candidate_score_gaps(latest_rubric)
            ):
                imperfect_score_epochs.add(latest_inner_result.epoch)
            for item in inner_history:
                if not isinstance(item, dict):
                    continue
                inner = item.get("inner")
                if isinstance(inner, dict):
                    raw_epoch = inner.get("epoch")
                    accepted = inner.get("accepted")
                    rubric = inner.get("rubric_validation")
                    inner_evidence = inner
                else:
                    raw_epoch = item.get("epoch")
                    accepted = item.get("accepted")
                    rubric = item.get("rubric_validation")
                    inner_evidence = item
                infrastructure_ok = (
                    rubric.get("infrastructure_ok")
                    if isinstance(rubric, dict)
                    else None
                )
                outcomes = [
                    outcome
                    for side in ("parent_outcomes", "candidate_outcomes")
                    for outcome in (inner_evidence.get(side) or [])
                    if isinstance(outcome, dict)
                ]
                if any(outcome.get("infrastructure_ok") is False for outcome in outcomes):
                    infrastructure_ok = False
                if (
                    isinstance(raw_epoch, int)
                    and accepted is False
                    and infrastructure_ok is True
                ):
                    failed_history_epochs.add(raw_epoch)
                if (
                    isinstance(raw_epoch, int)
                    and infrastructure_ok is True
                    and isinstance(rubric, dict)
                    and _compact_candidate_score_gaps(rubric)
                ):
                    imperfect_score_epochs.add(raw_epoch)
                library_update = item.get("outer_element_library_update")
                if isinstance(library_update, dict):
                    update_payload = library_update.get("library_update", library_update)
                    update_status = update_payload.get("status")
                else:
                    update_payload = {}
                    update_status = None
                if update_status is None:
                    outer = item.get("outer") if isinstance(item.get("outer"), dict) else {}
                    validation = outer.get("rubric_validation") if isinstance(outer, dict) else {}
                    if isinstance(validation, dict):
                        nested_update = validation.get("library_update")
                        if isinstance(nested_update, dict):
                            update_status = nested_update.get("status")
                if (
                    isinstance(raw_epoch, int)
                    and update_status == "failed_infrastructure_or_validation"
                ):
                    failed_outer_library_epochs.add(raw_epoch)
            try:
                update = self.store.apply_plan(
                    epoch=epoch,
                    shortlist=shortlist,
                    plan=plan,
                    failed_history_epochs=failed_history_epochs,
                    failed_outer_library_epochs=failed_outer_library_epochs,
                    imperfect_score_epochs=imperfect_score_epochs,
                    current_inner_element_ids=current_inner_ids,
                    non_adopted_element_ids=non_adopted_ids,
                )
            except ValueError as exc:
                fallback_plan = self._fallback_non_adoption_repair_plan(
                    shortlist=shortlist,
                    required_ids=required_non_adoption_repairs,
                )
                if (
                    fallback_plan is None
                    and not required_non_adoption_repairs
                    and any(item in non_adopted_ids for item in shortlist)
                ):
                    # An equivalent modify without an audited defect is not a
                    # reason to mutate the library. Preserve the catalog and
                    # let the epoch commit as an explicit no-op.
                    fallback_plan = {"operations": [], "additions": []}
                if (
                    "modify replacement must change the element" not in str(exc)
                    or fallback_plan is None
                ):
                    raise
                plan = self._validate_plan_throughput(
                    fallback_plan,
                    non_adopted_element_ids=non_adopted_ids,
                )
                self._validate_plan_evidence(
                    plan,
                    available_epochs=available_evidence_epochs,
                )
                record["fallback_repair"] = (
                    "repeated equivalent model replacement; committed no-op"
                    if not required_non_adoption_repairs
                    else "repeated equivalent model replacement"
                )
                update = self.store.apply_plan(
                    epoch=epoch,
                    shortlist=shortlist,
                    plan=plan,
                    failed_history_epochs=failed_history_epochs,
                    failed_outer_library_epochs=failed_outer_library_epochs,
                    imperfect_score_epochs=imperfect_score_epochs,
                    current_inner_element_ids=current_inner_ids,
                    non_adopted_element_ids=non_adopted_ids,
                )
            record.update(status=update.status, plan=plan, update=update.to_dict())
            try:
                self.store.write_epoch_record(epoch, record)
            except Exception as exc:  # noqa: BLE001 - preserve the committed update.
                # Catalog and stats are authoritative once their transaction commits.
                # Surface the audit failure without misreporting the applied revision.
                audit_record_error = f"audit_record_error: {type(exc).__name__}: {exc}"
            if audit_record_error is not None:
                update = replace(update, error=audit_record_error)
            return update
        except Exception as exc:  # noqa: BLE001 - return a persisted failed update.
            update = OuterLibraryUpdate(
                epoch=epoch,
                status="failed_infrastructure_or_validation",
                revision_before=revision,
                revision_after=revision,
                shortlist=tuple(record.get("shortlist", ())),
                operations=(),
                additions=(),
                error=f"{type(exc).__name__}: {exc}",
            )
            record.update(status=update.status, error=update.error, update=update.to_dict())
            self.store.write_epoch_record(epoch, record)
            return update
