from __future__ import annotations

import ast
import json
import os
import re
from collections import defaultdict
from collections.abc import Callable, Iterable
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
            literal_value = re.sub(r"\btrue\b", "True", repaired, flags=re.IGNORECASE)
            literal_value = re.sub(
                r"\bfalse\b", "False", literal_value, flags=re.IGNORECASE
            )
            literal_value = re.sub(
                r"\bnull\b", "None", literal_value, flags=re.IGNORECASE
            )
            parsed = ast.literal_eval(literal_value)
    if not isinstance(parsed, dict):
        raise TypeError("outer library agent must return one JSON object")
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
    return compact


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
                    elif isinstance(epoch, str) and epoch.strip().isdigit():
                        converted.append(int(epoch.strip()))
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
        usage_path = self.usage_dir / f"inner_epoch_{result.epoch:03d}.json"
        if usage_path.is_file():
            existing = read_json(usage_path)
            expected = {
                "candidate_harness_id": result.candidate_harness_id,
                "element_ids": list(requested),
            }
            actual = {key: existing.get(key) for key in expected}
            if actual != expected:
                raise ValueError(
                    f"conflicting outer-element attribution for inner epoch {result.epoch}"
                )
            return existing

        score, hard_regression = inner_harness_score_and_hard_regression(result)
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
    ) -> None:
        stat = metadata[element_id]
        if _outer_dynamics_mode():
            min_usage = _outer_dynamics_int(
                "GAME_LOOP_OUTER_LIBRARY_DYNAMICS_MODIFY_MIN_USAGE",
                0,
            )
            if int(stat.get("usage_count", 0)) < min_usage:
                raise ValueError(f"modify requires at least {min_usage} uses: {element_id}")
            if replacement == current:
                raise ValueError(f"modify replacement must change the element: {element_id}")
            if not str(decision.get("correction_hypothesis", "")).strip():
                raise ValueError(f"modify requires a correction hypothesis: {element_id}")
            return
        if int(stat.get("usage_count", 0)) < 3:
            raise ValueError(f"modify requires at least 3 uses: {element_id}")
        if (
            not self._is_low_score(element_id, metadata)
            and stat.get("hard_regression_ever") is not True
        ):
            raise ValueError(f"modify lacks near-deletion evidence: {element_id}")
        if replacement == current:
            raise ValueError(f"modify replacement must change the element: {element_id}")
        if not str(decision.get("correction_hypothesis", "")).strip():
            raise ValueError(f"modify requires a correction hypothesis: {element_id}")

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
        current_inner_element_ids: Iterable[str] = (),
    ) -> OuterLibraryUpdate:
        catalog = self.catalog()
        plan = _normalize_outer_plan(plan)
        revision_before = self.revision()
        current_inner_ids = tuple(dict.fromkeys(
            str(item) for item in current_inner_element_ids
        ))
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
        added_ids: list[str] = []
        for addition in additions:
            if str(addition.get("operation", "add")).casefold() != "add":
                raise ValueError("outer addition must use operation=add")
            if not str(addition.get("capability_boundary_evidence", "")).strip():
                raise ValueError("add requires capability-boundary evidence")
            supporting_epochs = addition.get("supporting_epoch_ids", [])
            if not isinstance(supporting_epochs, list):
                raise ValueError(
                    "add requires supporting failed inner or outer-library epoch ids"
                )
            if not supporting_epochs and not _outer_dynamics_mode():
                raise ValueError(
                    "add requires supporting failed inner or outer-library epoch ids"
                )
            if supporting_epochs and not all(
                isinstance(item, int) and item in available_epochs
                for item in supporting_epochs
            ):
                raise ValueError(
                    "add requires supporting failed inner or outer-library epoch ids"
                )
            spec = HarnessElementConfig.from_dict(dict(addition.get("element", {})))
            if spec.category not in ELEMENT_CATEGORIES:
                raise ValueError(f"invalid added element category {spec.category}")
            if spec.element_id in next_catalog:
                if _outer_dynamics_mode():
                    if spec.element_id not in added_ids:
                        added_ids.append(spec.element_id)
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
        revision_after = revision_before + (1 if changed or additions else 0)
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
            additions=tuple(dict(item) for item in additions),
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
    ):
        self.store = store
        self.request_json = request_json or self._request_with_configured_backbone

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
        response = LocalChatAgent()._call_api(
            [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": json.dumps(
                        {"stage": stage, **payload}, ensure_ascii=False
                    ),
                },
            ]
        )
        message = response["choices"][0]["message"]
        content = message.get("content") or message.get("reasoning_content") or ""
        return _extract_json_object(str(content))

    def evolve(
        self,
        *,
        epoch: int,
        inner_history: list[dict[str, Any]],
        latest_inner_result: HarnessEpochResult,
        current_inner_element_ids: Iterable[str] = (),
    ) -> OuterLibraryUpdate:
        current_inner_ids = tuple(dict.fromkeys(
            str(item) for item in current_inner_element_ids
        ))
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
            "created_at": utc_now(),
        }
        self.store.write_epoch_record(epoch, record)
        try:
            catalog_ids = {str(item["id"]) for item in record["catalog_index"]}
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
                f"Select at most {shortlist_limit} elements with enough evidence to consider delete, modify, "
                "or merge. Return {shortlist:[ids], addition_needed:boolean, rationale:string}. "
                "You have only index metadata now; do not claim to know hidden details."
            )
            if _outer_dynamics_mode():
                shortlist_task += (
                    " Dynamics-study mode is active: prefer a diverse shortlist that exposes "
                    "contrasting outer_exposure patterns, including repeatedly disclosed unchanged "
                    "elements, inactive/dormant elements, and active high-use elements."
                )
            shortlist_response = self.request_json(
                "shortlist",
                {
                    "catalog_index": record["catalog_index"],
                    "shortlist_limit": shortlist_limit,
                    "inner_history": _compact_outer_inner_history(inner_history[-20:]),
                    "latest_inner_result": _compact_inner_epoch_result(
                        latest_inner_result
                    ),
                    "current_inner_element_ids": list(current_inner_ids),
                    "task": shortlist_task,
                },
            )
            shortlist_raw = shortlist_response.get("shortlist", [])
            if not isinstance(shortlist_raw, list):
                raise TypeError("outer shortlist must be a list")
            unknown_shortlist = sorted(
                {str(item) for item in shortlist_raw} - catalog_ids
            )
            if unknown_shortlist:
                raise ValueError(
                    f"outer shortlist returned unknown ids: {unknown_shortlist}"
                )
            if len(shortlist_raw) > shortlist_limit:
                raise ValueError(
                    "outer shortlist exceeds progressive disclosure limit "
                    f"{shortlist_limit}: {len(shortlist_raw)}"
                )
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
                "Return operations only for existing elements that should be delete, modify, "
                "or merge. Omit elements that should remain unchanged; the system will treat "
                "omitted elements as unchanged. Undisclosed elements may not be changed. "
                "Delete only when usage is high, score is low, and modification "
                "cannot repair it; include modification_inadequate_reason. Modify elements "
                "near deletion when a concrete correction may improve them, preserving id and "
                "category in replacement. Merge only two highly similar disclosed elements, "
                "with symmetric merge decisions and the same merged_element payload. Add only "
                "when historical failures prove a capability boundary; put additions in a "
                "separate additions list with capability_boundary_evidence and supporting failed "
                "inner or outer-library epoch IDs in supporting_epoch_ids. Schema: "
                "{operations:[{element_id,operation,reason,...}], additions:[...]}. "
                "Use operation=unchanged only when you intentionally want to document why a "
                "disclosed element was inspected but kept."
            )
            if _outer_dynamics_mode():
                plan_task = (
                    "Dynamics-study mode is active. Produce sparse non-keep actions when the "
                    "evidence shows useful library differentiation; do not emit operations for "
                    "elements that should merely stay unchanged. You may delete dormant elements "
                    "that have been repeatedly shortlisted/disclosed yet remain unused when you "
                    "explain why modification is inadequate. You may modify an unused or active "
                    "element when the replacement preserves id/category and gives a concrete "
                    "correction_hypothesis. You may merge moderately similar disclosed elements "
                    "with symmetric merge decisions. You may add a distinct exploratory boundary "
                    "element from repeated no-op, shortlist, or outer-library failure patterns; "
                    "supporting_epoch_ids may be empty only when the evidence is repeated "
                    "outer_exposure rather than a failed epoch. Keep actions sparse: normally 1 "
                    "structural action per epoch, at most 2 additions. Schema: "
                    "{operations:[{element_id,operation,reason,...}], additions:[...]}. "
                    "For zero-use deletion include unused_or_dormant_evidence and "
                    "modification_inadequate_reason."
                )
            plan = self.request_json(
                "plan",
                {
                    "all_element_ids": sorted(catalog_ids),
                    "shortlist": list(shortlist),
                    "disclosed_elements": record["disclosed_elements"],
                    "element_metadata": self.store.metadata(),
                    "inner_history": _compact_outer_inner_history(inner_history[-20:]),
                    "latest_inner_result": _compact_inner_epoch_result(
                        latest_inner_result
                    ),
                    "current_inner_element_ids": list(current_inner_ids),
                    "operations": sorted(OUTER_LIBRARY_OPERATIONS),
                    "task": plan_task,
                },
            )
            record.update(status="applying", plan=plan)
            audit_record_error: str | None = None
            try:
                self.store.write_epoch_record(epoch, record)
            except Exception as exc:  # noqa: BLE001 - keep the valid plan actionable.
                audit_record_error = f"audit_record_error: {type(exc).__name__}: {exc}"
            failed_history_epochs: set[int] = set()
            failed_outer_library_epochs: set[int] = set()
            if not latest_inner_result.accepted:
                failed_history_epochs.add(latest_inner_result.epoch)
            for item in inner_history:
                if not isinstance(item, dict):
                    continue
                inner = item.get("inner")
                if isinstance(inner, dict):
                    raw_epoch = inner.get("epoch")
                    accepted = inner.get("accepted")
                else:
                    raw_epoch = item.get("epoch")
                    accepted = item.get("accepted")
                if isinstance(raw_epoch, int) and accepted is False:
                    failed_history_epochs.add(raw_epoch)
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
            update = self.store.apply_plan(
                epoch=epoch,
                shortlist=shortlist,
                plan=plan,
                failed_history_epochs=failed_history_epochs,
                failed_outer_library_epochs=failed_outer_library_epochs,
                current_inner_element_ids=current_inner_ids,
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
