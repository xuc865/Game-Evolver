from __future__ import annotations

import json
import re
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
        start = value.find("{")
        end = value.rfind("}")
        if start >= 0 and end > start:
            value = value[start : end + 1]
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise TypeError("outer library agent must return one JSON object")
    return parsed


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

    def progressive_index(self) -> list[dict[str, Any]]:
        metadata = self.metadata()
        return [
            {
                "id": spec.element_id,
                "category": spec.category,
                "tags": list(spec.tags),
                "usage": metadata[spec.element_id],
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

    def apply_plan(
        self,
        *,
        epoch: int,
        shortlist: Iterable[str],
        plan: dict[str, Any],
        failed_history_epochs: Iterable[int] = (),
        current_inner_element_ids: Iterable[str] = (),
    ) -> OuterLibraryUpdate:
        catalog = self.catalog()
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
        if set(decisions) != set(catalog):
            missing = sorted(set(catalog) - set(decisions))
            unknown = sorted(set(decisions) - set(catalog))
            raise ValueError(
                f"outer plan must cover every current element; missing={missing}, unknown={unknown}"
            )
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
                if (
                    element_similarity(left, right) < 0.55
                    or _element_content_similarity(left, right) < 0.50
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
        added_ids: list[str] = []
        for addition in additions:
            if str(addition.get("operation", "add")).casefold() != "add":
                raise ValueError("outer addition must use operation=add")
            if not str(addition.get("capability_boundary_evidence", "")).strip():
                raise ValueError("add requires capability-boundary evidence")
            supporting_epochs = addition.get("supporting_epoch_ids", [])
            if (
                not isinstance(supporting_epochs, list)
                or not supporting_epochs
                or not all(isinstance(item, int) and item in available_epochs for item in supporting_epochs)
            ):
                raise ValueError("add requires supporting failed epoch ids from inner history")
            spec = HarnessElementConfig.from_dict(dict(addition.get("element", {})))
            if spec.category not in ELEMENT_CATEGORIES:
                raise ValueError(f"invalid added element category {spec.category}")
            if spec.element_id in next_catalog:
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
            shortlist_limit = min(
                len(catalog_ids),
                max(1, min(8, (len(catalog_ids) + 2) // 3)),
            )
            shortlist_response = self.request_json(
                "shortlist",
                {
                    "catalog_index": record["catalog_index"],
                    "shortlist_limit": shortlist_limit,
                    "inner_history": inner_history[-20:],
                    "latest_inner_result": latest_inner_result.to_dict(),
                    "current_inner_element_ids": list(current_inner_ids),
                    "task": (
                        f"Select at most {shortlist_limit} elements with enough evidence to consider delete, modify, "
                        "or merge. Return {shortlist:[ids], addition_needed:boolean, rationale:string}. "
                        "You have only index metadata now; do not claim to know hidden details."
                    ),
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
            plan = self.request_json(
                "plan",
                {
                    "all_element_ids": sorted(catalog_ids),
                    "shortlist": list(shortlist),
                    "disclosed_elements": record["disclosed_elements"],
                    "element_metadata": self.store.metadata(),
                    "inner_history": inner_history[-20:],
                    "latest_inner_result": latest_inner_result.to_dict(),
                    "current_inner_element_ids": list(current_inner_ids),
                    "operations": sorted(OUTER_LIBRARY_OPERATIONS),
                    "task": (
                        "Return an operation for every existing element. Undisclosed elements must "
                        "be unchanged. Delete only when usage is high, score is low, and modification "
                        "cannot repair it; include modification_inadequate_reason. Modify elements "
                        "near deletion when a concrete correction may improve them, preserving id and "
                        "category in replacement. Merge only two highly similar disclosed elements, "
                        "with symmetric merge decisions and the same merged_element payload. Add only "
                        "when historical failures prove a capability boundary; put additions in a "
                        "separate additions list with capability_boundary_evidence and supporting failed "
                        "inner-epoch IDs in supporting_epoch_ids. Schema: "
                        "{operations:[{element_id,operation,reason,...}], additions:[...]}."
                    ),
                },
            )
            failed_history_epochs: set[int] = set()
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
            update = self.store.apply_plan(
                epoch=epoch,
                shortlist=shortlist,
                plan=plan,
                failed_history_epochs=failed_history_epochs,
                current_inner_element_ids=current_inner_ids,
            )
            record.update(status=update.status, plan=plan, update=update.to_dict())
            try:
                self.store.write_epoch_record(epoch, record)
            except Exception as exc:  # noqa: BLE001 - preserve the committed update.
                # Catalog and stats are authoritative once their transaction commits.
                # Surface the audit failure without misreporting the applied revision.
                update = replace(
                    update,
                    error=f"audit_record_error: {type(exc).__name__}: {exc}",
                )
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
