from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from game_loop.core.agent_circuit_evolution import _OPERATIONS
from game_loop.utils import atomic_write_json, read_json, sha256_json, utc_now


@dataclass(frozen=True)
class HarnessTransformation:
    transformation_id: str
    name: str
    description: str
    trigger_signals: tuple[str, ...]
    supported_operations: tuple[str, ...]
    plan_template: dict[str, Any]
    tags: tuple[str, ...] = ()
    cost_prior: float = 1.0

    def __post_init__(self) -> None:
        if not self.transformation_id.strip() or not self.name.strip() or not self.description.strip():
            raise ValueError("harness transformation id, name, and description are required")
        if not self.trigger_signals:
            raise ValueError("harness transformation requires trigger signals")
        unknown = sorted(set(self.supported_operations) - _OPERATIONS)
        if unknown:
            raise ValueError(f"harness transformation has unsupported operations: {unknown}")
        if not self.supported_operations or not self.plan_template:
            raise ValueError("harness transformation requires operations and a plan template")
        if self.cost_prior <= 0:
            raise ValueError("harness transformation cost_prior must be positive")
        object.__setattr__(
            self, "trigger_signals", tuple(sorted(dict.fromkeys(self.trigger_signals)))
        )
        object.__setattr__(
            self,
            "supported_operations",
            tuple(sorted(dict.fromkeys(self.supported_operations))),
        )
        object.__setattr__(self, "tags", tuple(sorted(dict.fromkeys(self.tags))))
        object.__setattr__(self, "cost_prior", float(self.cost_prior))

    @property
    def spec_hash(self) -> str:
        return sha256_json(self.to_dict(include_hash=False))

    def to_dict(self, *, include_hash: bool = True) -> dict[str, Any]:
        value = {
            "id": self.transformation_id,
            "name": self.name,
            "description": self.description,
            "trigger_signals": list(self.trigger_signals),
            "supported_operations": list(self.supported_operations),
            "plan_template": dict(self.plan_template),
            "tags": list(self.tags),
            "cost_prior": self.cost_prior,
        }
        return {**value, "spec_hash": self.spec_hash} if include_hash else value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> HarnessTransformation:
        result = cls(
            transformation_id=str(value.get("id", value.get("transformation_id", ""))),
            name=str(value["name"]),
            description=str(value["description"]),
            trigger_signals=tuple(str(item) for item in value.get("trigger_signals", [])),
            supported_operations=tuple(
                str(item) for item in value.get("supported_operations", [])
            ),
            plan_template=dict(value.get("plan_template", {})),
            tags=tuple(str(item) for item in value.get("tags", [])),
            cost_prior=float(value.get("cost_prior", 1.0)),
        )
        supplied = str(value.get("spec_hash", ""))
        if supplied and supplied != result.spec_hash:
            raise ValueError(
                f"harness transformation {result.transformation_id} hash mismatch"
            )
        return result


@dataclass
class TransformationStats:
    uses: int = 0
    successes: int = 0
    quality_delta_total: float = 0.0
    cost_penalty_total: float = 0.0
    net_utility_total: float = 0.0
    hard_regressions: int = 0
    attributed_epochs: list[int] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        return self.successes / self.uses if self.uses else 0.0

    @property
    def mean_quality_delta(self) -> float:
        return self.quality_delta_total / self.uses if self.uses else 0.0

    @property
    def mean_net_utility(self) -> float:
        return self.net_utility_total / self.uses if self.uses else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "success_rate": self.success_rate,
            "mean_quality_delta": self.mean_quality_delta,
            "mean_net_utility": self.mean_net_utility,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> TransformationStats:
        return cls(
            uses=int(value.get("uses", 0)),
            successes=int(value.get("successes", 0)),
            quality_delta_total=float(value.get("quality_delta_total", 0)),
            cost_penalty_total=float(value.get("cost_penalty_total", 0)),
            net_utility_total=float(value.get("net_utility_total", 0)),
            hard_regressions=int(value.get("hard_regressions", 0)),
            attributed_epochs=[int(item) for item in value.get("attributed_epochs", [])],
        )


@dataclass(frozen=True)
class TransformationLibraryAction:
    action_id: str
    operation: str
    rationale: str
    evidence_refs: tuple[str, ...]
    payload: dict[str, Any]

    def __post_init__(self) -> None:
        if self.operation not in {"add", "delete", "modify", "merge"}:
            raise ValueError(f"unsupported transformation library operation: {self.operation}")
        if not self.action_id or not self.rationale or not self.evidence_refs:
            raise ValueError("transformation library action requires id, rationale, and evidence")


class HarnessTransformationLibraryStore:
    schema_version = "harness-transformation-library.v1"
    quarantine_schema_version = "harness-transformation-quarantine.v1"
    validator_revision = "workspace-lineage-v1"

    def __init__(self, root: Path):
        self.root = root
        self.catalog_path = root / "catalog.json"
        self.stats_path = root / "stats.json"
        self.quarantine_path = root / "quarantine.json"
        self.pending_path = root / ".pending_transaction.json"
        self.epochs_dir = root / "epochs"

    def initialize(
        self,
        transformations: Iterable[HarnessTransformation] | None = None,
    ) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.epochs_dir.mkdir(parents=True, exist_ok=True)
        self._recover_pending_transaction()
        if not self.catalog_path.is_file():
            items = tuple(
                default_transformations()
                if transformations is None
                else transformations
            )
            self._write_catalog(items, revision=0)
        if not self.stats_path.is_file():
            self._write_stats({item.transformation_id: TransformationStats() for item in self.catalog().values()})

    def _recover_pending_transaction(self) -> None:
        if not self.pending_path.is_file():
            return
        pending = read_json(self.pending_path)
        transformations = tuple(
            HarnessTransformation.from_dict(item)
            for item in pending.get("catalog", [])
        )
        stats = {
            str(key): TransformationStats.from_dict(value)
            for key, value in dict(pending.get("stats", {})).items()
        }
        if not transformations:
            raise ValueError("pending transformation transaction has an empty catalog")
        self._write_catalog(
            transformations,
            revision=int(pending["revision_after"]),
        )
        self._write_stats(stats)
        self.pending_path.unlink(missing_ok=True)

    def revision(self) -> int:
        return int(read_json(self.catalog_path).get("revision", 0))

    def catalog(self) -> dict[str, HarnessTransformation]:
        raw = read_json(self.catalog_path)
        result: dict[str, HarnessTransformation] = {}
        for item in raw.get("items", []):
            transformation = HarnessTransformation.from_dict(item)
            if transformation.transformation_id in result:
                raise ValueError("duplicate harness transformation id")
            result[transformation.transformation_id] = transformation
        return result

    def stats(self) -> dict[str, TransformationStats]:
        raw = read_json(self.stats_path)
        return {
            str(key): TransformationStats.from_dict(value)
            for key, value in raw.get("items", {}).items()
        }

    def quarantine_issues(
        self,
        *,
        circuit_id: str | None = None,
        transformation_ids: Iterable[str] | None = None,
    ) -> tuple[dict[str, Any], ...]:
        if not self.quarantine_path.is_file():
            return ()
        raw = read_json(self.quarantine_path)
        allowed = (
            None
            if transformation_ids is None
            else {str(item) for item in transformation_ids}
        )
        return tuple(
            dict(item)
            for item in raw.get("items", [])
            if (circuit_id is None or item.get("circuit_id") == circuit_id)
            and (allowed is None or item.get("transformation_id") in allowed)
        )

    def quarantine_reason(
        self,
        transformation: HarnessTransformation,
        *,
        circuit_id: str,
    ) -> str | None:
        for item in self.quarantine_issues(
            circuit_id=circuit_id,
            transformation_ids=(transformation.transformation_id,),
        ):
            if (
                item.get("spec_hash") == transformation.spec_hash
                and item.get("validator_revision") == self.validator_revision
            ):
                return str(item.get("reason", "invalid transformation"))
        return None

    def record_quarantine(
        self,
        transformation: HarnessTransformation,
        *,
        circuit_id: str,
        reason: str,
        stage: str,
    ) -> dict[str, Any]:
        self.root.mkdir(parents=True, exist_ok=True)
        items = list(self.quarantine_issues())
        key = (
            transformation.transformation_id,
            transformation.spec_hash,
            circuit_id,
            self.validator_revision,
        )
        now = utc_now()
        for item in items:
            item_key = (
                item.get("transformation_id"),
                item.get("spec_hash"),
                item.get("circuit_id"),
                item.get("validator_revision"),
            )
            if item_key != key:
                continue
            item.update(
                reason=str(reason),
                stage=str(stage),
                observations=int(item.get("observations", 1)) + 1,
                last_seen_at=now,
            )
            record = item
            break
        else:
            record = {
                "transformation_id": transformation.transformation_id,
                "spec_hash": transformation.spec_hash,
                "circuit_id": circuit_id,
                "validator_revision": self.validator_revision,
                "reason": str(reason),
                "stage": str(stage),
                "observations": 1,
                "first_seen_at": now,
                "last_seen_at": now,
            }
            items.append(record)
        atomic_write_json(
            self.quarantine_path,
            {
                "schema_version": self.quarantine_schema_version,
                "items": sorted(
                    items,
                    key=lambda item: (
                        str(item.get("transformation_id", "")),
                        str(item.get("circuit_id", "")),
                        str(item.get("spec_hash", "")),
                    ),
                ),
                "updated_at": now,
            },
        )
        return dict(record)

    def shortlist(self, signals: Iterable[str], *, limit: int = 4) -> tuple[str, ...]:
        if limit < 1:
            raise ValueError("transformation shortlist limit must be positive")
        wanted = {str(item).casefold() for item in signals}
        stats = self.stats()

        def score(item: HarnessTransformation) -> tuple[float, str]:
            stat = stats.get(item.transformation_id, TransformationStats())
            overlap = len(wanted & {signal.casefold() for signal in item.trigger_signals})
            exploration = 1.0 / (1 + stat.uses)
            utility = stat.mean_net_utility
            hard_penalty = 0.5 * stat.hard_regressions
            return (3.0 * overlap + exploration + utility - hard_penalty, item.transformation_id)

        ranked = sorted(self.catalog().values(), key=score, reverse=True)
        return tuple(item.transformation_id for item in ranked[:limit])

    def progressive_index(self) -> list[dict[str, Any]]:
        stats = self.stats()
        return [
            {
                "id": item.transformation_id,
                "name": item.name,
                "description": item.description,
                "trigger_signals": list(item.trigger_signals),
                "supported_operations": list(item.supported_operations),
                "tags": list(item.tags),
                "cost_prior": item.cost_prior,
                "uses": stats.get(item.transformation_id, TransformationStats()).uses,
                "success_rate": stats.get(
                    item.transformation_id, TransformationStats()
                ).success_rate,
                "mean_net_utility": stats.get(
                    item.transformation_id, TransformationStats()
                ).mean_net_utility,
            }
            for item in sorted(self.catalog().values(), key=lambda value: value.transformation_id)
        ]

    def details(self, transformation_ids: Iterable[str]) -> list[dict[str, Any]]:
        catalog = self.catalog()
        stats = self.stats()
        result: list[dict[str, Any]] = []
        for transformation_id in dict.fromkeys(str(item) for item in transformation_ids):
            if transformation_id not in catalog:
                raise ValueError(f"unknown harness transformation: {transformation_id}")
            result.append(
                {
                    **catalog[transformation_id].to_dict(),
                    "stats": stats.get(
                        transformation_id, TransformationStats()
                    ).to_dict(),
                }
            )
        return result

    def record_use(
        self,
        *,
        transformation_ids: Iterable[str],
        epoch: int,
        success: bool,
        quality_delta: float,
        cost_penalty: float,
        hard_regression: bool = False,
    ) -> None:
        catalog = self.catalog()
        stats = self.stats()
        for transformation_id in dict.fromkeys(transformation_ids):
            if transformation_id not in catalog:
                raise ValueError(f"unknown harness transformation: {transformation_id}")
            stat = stats.setdefault(transformation_id, TransformationStats())
            if epoch in stat.attributed_epochs:
                raise ValueError(
                    f"transformation {transformation_id} already attributed at epoch {epoch}"
                )
            stat.uses += 1
            stat.successes += int(success)
            stat.quality_delta_total += quality_delta
            stat.cost_penalty_total += cost_penalty
            stat.net_utility_total += quality_delta - cost_penalty
            stat.hard_regressions += int(hard_regression)
            stat.attributed_epochs.append(epoch)
        self._write_stats(stats)

    def apply_actions(
        self,
        *,
        epoch: int,
        actions: Iterable[TransformationLibraryAction],
        max_actions: int = 4,
        max_additions: int = 2,
        validate_transformation: Callable[[HarnessTransformation], None] | None = None,
    ) -> dict[str, Any]:
        action_list = tuple(actions)
        if len(action_list) > max_actions:
            raise ValueError("transformation library action limit exceeded")
        if sum(item.operation == "add" for item in action_list) > max_additions:
            raise ValueError("transformation library addition limit exceeded")
        catalog = self.catalog()
        next_catalog = dict(catalog)
        changed_ids: set[str] = set()
        for action in action_list:
            if action.operation == "add":
                item = HarnessTransformation.from_dict(action.payload["transformation"])
                if item.transformation_id in next_catalog:
                    raise ValueError(f"transformation already exists: {item.transformation_id}")
                next_catalog[item.transformation_id] = item
                changed_ids.add(item.transformation_id)
            elif action.operation == "delete":
                transformation_id = str(action.payload["transformation_id"])
                if transformation_id not in next_catalog:
                    raise ValueError(f"unknown transformation: {transformation_id}")
                next_catalog.pop(transformation_id)
            elif action.operation == "modify":
                transformation_id = str(action.payload["transformation_id"])
                replacement = HarnessTransformation.from_dict(action.payload["replacement"])
                if transformation_id not in next_catalog or replacement.transformation_id != transformation_id:
                    raise ValueError("modify must preserve a known transformation id")
                next_catalog[transformation_id] = replacement
                changed_ids.add(transformation_id)
            elif action.operation == "merge":
                source_ids = {str(item) for item in action.payload.get("source_ids", [])}
                if len(source_ids) < 2 or not source_ids <= set(next_catalog):
                    raise ValueError("merge requires at least two known transformations")
                merged = HarnessTransformation.from_dict(action.payload["merged"])
                if merged.transformation_id in next_catalog and merged.transformation_id not in source_ids:
                    raise ValueError("merged transformation id collides with catalog")
                for source_id in source_ids:
                    next_catalog.pop(source_id)
                next_catalog[merged.transformation_id] = merged
                changed_ids.add(merged.transformation_id)
        if not next_catalog:
            raise ValueError("transformation library cannot be empty")
        if validate_transformation is not None:
            for transformation_id in sorted(changed_ids):
                validate_transformation(next_catalog[transformation_id])
        revision_before = self.revision()
        revision_after = revision_before + int(bool(action_list))
        stats = self.stats()
        for transformation_id in next_catalog:
            stats.setdefault(transformation_id, TransformationStats())
        next_stats = {key: value for key, value in stats.items() if key in next_catalog}
        if action_list:
            atomic_write_json(
                self.pending_path,
                {
                    "schema_version": "harness-transformation-pending.v1",
                    "epoch": epoch,
                    "revision_before": revision_before,
                    "revision_after": revision_after,
                    "catalog": [
                        item.to_dict()
                        for item in sorted(
                            next_catalog.values(),
                            key=lambda value: value.transformation_id,
                        )
                    ],
                    "stats": {
                        key: next_stats[key].to_dict() for key in sorted(next_stats)
                    },
                    "created_at": utc_now(),
                },
            )
        self._write_catalog(next_catalog.values(), revision=revision_after)
        self._write_stats(next_stats)
        self.pending_path.unlink(missing_ok=True)
        record = {
            "schema_version": "harness-transformation-library-epoch.v1",
            "epoch": epoch,
            "revision_before": revision_before,
            "revision_after": revision_after,
            "actions": [
                {
                    "action_id": item.action_id,
                    "operation": item.operation,
                    "rationale": item.rationale,
                    "evidence_refs": list(item.evidence_refs),
                    "payload": item.payload,
                }
                for item in action_list
            ],
            "created_at": utc_now(),
        }
        atomic_write_json(self.epochs_dir / f"epoch_{epoch:03d}.json", record)
        return record

    def write_epoch_record(self, epoch: int, payload: Mapping[str, Any]) -> None:
        self.epochs_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.epochs_dir / f"epoch_{epoch:03d}.json", dict(payload))

    def _write_catalog(
        self,
        transformations: Iterable[HarnessTransformation],
        *,
        revision: int,
    ) -> None:
        atomic_write_json(
            self.catalog_path,
            {
                "schema_version": self.schema_version,
                "revision": revision,
                "items": [
                    item.to_dict()
                    for item in sorted(
                        transformations, key=lambda value: value.transformation_id
                    )
                ],
                "updated_at": utc_now(),
            },
        )

    def _write_stats(self, stats: Mapping[str, TransformationStats]) -> None:
        atomic_write_json(
            self.stats_path,
            {
                "schema_version": "harness-transformation-stats.v1",
                "items": {key: stats[key].to_dict() for key in sorted(stats)},
                "updated_at": utc_now(),
            },
        )


def default_transformations() -> tuple[HarnessTransformation, ...]:
    return (
        HarnessTransformation(
            "single_to_studio",
            "Single agent to studio",
            "Split an overloaded maker into director, independent specialists, integrator, and critic.",
            ("cross_domain_failure", "gameplay_gap", "presentation_gap", "single_agent"),
            ("split_role", "modify_policy", "modify_boundaries"),
            {"shape": "director_parallel_specialists_integrator_critic"},
            ("deep_evolution", "studio", "topology"),
            4.0,
        ),
        HarnessTransformation(
            "add_critic_feedback",
            "Add bounded critic feedback",
            "Add an independent playtester and a bounded evidence-backed repair edge.",
            ("interaction_gap", "missing_end_state", "regression"),
            ("add_role", "add_edge", "modify_policy", "modify_boundaries"),
            {"shape": "critic_feedback", "max_traversals": 1},
            ("quality_gate", "review", "topology"),
            2.0,
        ),
        HarnessTransformation(
            "parallelize_specialists",
            "Parallelize independent specialists",
            "Split independent capability boundaries into parallel isolated roles.",
            ("latency", "independent_tasks", "specialization_gap"),
            ("split_role", "add_edge", "modify_policy"),
            {"shape": "parallel_fanout_fanin"},
            ("parallel", "specialization", "topology"),
            2.5,
        ),
        HarnessTransformation(
            "merge_redundant_roles",
            "Merge redundant roles",
            "Merge roles whose outputs and responsibilities repeatedly overlap.",
            ("duplicate_work", "coordination_overhead", "low_marginal_value"),
            ("merge_roles", "modify_policy"),
            {"shape": "merged_specialist"},
            ("cost", "simplification", "topology"),
            0.5,
        ),
        HarnessTransformation(
            "tighten_artifact_handoff",
            "Tighten artifact handoff",
            "Replace broad shared context with typed artifacts and concise summaries.",
            ("context_bloat", "integration_failure", "handoff_ambiguity"),
            ("modify_edge", "modify_role"),
            {"shape": "typed_artifact_mailbox"},
            ("artifact", "context", "protocol"),
            0.8,
        ),
    )
